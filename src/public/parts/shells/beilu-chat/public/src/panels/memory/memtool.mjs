/**
 * memtool.mjs — 记忆模式工具栏与主区多视图 cluster
 *
 * 功能链：进入记忆 Tab → initMemToolbar() 绑定工具栏按钮（table/diag/snapshot/retrieval/format/pseries；vocab 已删T006；skills 已迁 settings/skillLibrary.mjs 0723）
 *   → 点击工具按钮时切换主区视图并调用 _lazyLoadMemTool() 懒加载对应工具（单次加载缓存）
 *   → _toggleMemMainArea() 响应活动栏切换（记忆内容/检索诊断/运维三主区互斥）
 *   → _showMemContentSub/_showDiagretrSub/_showOpsSub 控制各主区内部子 Tab 显示
 *   → 各工具视图通过 MEM_API(/api/parts/plugins:beilu-memory/config/setdata) 读写记忆数据
 * why：记忆系统有表格/诊断/快照/检索/格式化/P系列等多个工具视图（词库/说明书库已删），集中在此管理懒加载和视图切换，
 *   避免非活跃工具占用 API 请求和 DOM 资源
 * 关联链：被 layout.mjs import（initMemToolbar 在 initLayout 时调用）；
 *   被 ide.mjs import（_toggleMemMainArea）、memswitch.mjs import（_show*Sub）；
 *   import api-client.mjs（记忆数据读写）、beiluDialog.mjs（确认/输入框）
 * 影响范围：改动影响记忆 Tab 下所有工具面板的加载、记忆表格数据展示、诊断/快照/检索等功能
 * 使用效果：用户切到记忆 Tab 点击「表格」工具，首次才拉取数据渲染；再次点击同一按钮收起回到对话视图
 */
import { escapeHtml } from "../../shared/state/utils.mjs";
import { getCharId } from "../../shared/state/sharedState.mjs"; // P4c：charId 单源（原读 #char-name-display textContent 会把占位文案"未加载角色"当 charId 用=死面板根因）
import { sendAction } from "../../shared/transport/sendAction.mjs"; // T6b：出向统一门面（memory 通配 verb=真动作组装 _action；getData 走桥路由）
import { storage, KEYS } from "../../shared/state/storage.mjs";
import { beiluConfirm, beiluPrompt } from "../../shared/widgets/beiluDialog.mjs";
import { enableDragAutoScroll } from "../../shared/widgets/dragAutoScroll.mjs"; // 0722：拖拽排序中 wheel 被浏览器抑制→边缘自动滚动
import { applyParamSchemaToInputs } from "../../shared/state/paramSchemaCache.mjs"; // P系列参数控件值域后端单源覆盖（同 subModePanel）
import { ENUM_FALLBACK } from "../../shared/state/enumFallback.mjs"; // 0715 V3 收口：pp/预填充离线退化表单源（原 _PSERIES_ENUM_FALLBACK 副本已删）
const _escHtml = escapeHtml; // memtool 用的共享 alias（layout.mjs:24 同名,不随迁,此处自备）

// ============================================================
// 记忆模式工具栏
// ============================================================

// 界面8: 活动栏 5 层记忆层级按钮已删（去两处切换重复，文件树一棵树直列五层徽章直接点；
// 原 beilu:mem-focus-level 事件无 consumer=断链，一并清）

function initMemToolbar() {
  const toolbar = document.getElementById("mem-toolbar");
  if (!toolbar) return;
  let _activeMemTool = null;

  toolbar.querySelectorAll("[data-mem-tool]").forEach(btn => {
    btn.addEventListener("click", () => {
      const tool = btn.dataset.memTool;
      const chatView = document.getElementById("mem-chat-view");
      const fileView = document.getElementById("mem-file-view");
      const toolPanel = document.getElementById("mem-tool-panel");

      if (_activeMemTool === tool) {
        // 再次点击：关闭工具面板，回到对话视图
        if (toolPanel) toolPanel.style.display = "none";
        if (chatView) chatView.style.display = "";
        toolbar.querySelectorAll("[data-mem-tool]").forEach(b => b.classList.remove("btn-active"));
        _activeMemTool = null;
        return;
      }

      _activeMemTool = tool;
      if (chatView) chatView.style.display = "none";
      if (fileView) fileView.style.display = "none";
      if (toolPanel) toolPanel.style.display = "";

      toolPanel?.querySelectorAll(".mem-tool-view").forEach(v => v.classList.add("hidden"));
      const target = document.getElementById(`mem-tool-${tool}-view`);
      if (target) target.classList.remove("hidden");

      toolbar.querySelectorAll("[data-mem-tool]").forEach(b => b.classList.remove("btn-active"));
      btn.classList.add("btn-active");

      _lazyLoadMemTool(tool, target);
    });
  });

  // T040a 就地设置条：记忆内容面板顶部常驻 chip 条（凛倾「直接在记忆表格上方就地放设置」）
  initMemSettingsStrip();
}

// ============================================================
// T040a: 就地设置条（方案B 悬停示能 + chip 常驻 + 就地展开改）
//   凛倾原话(231:5237)：「设置不要藏进弹窗或导航，直接在记忆表格上方就地放设置，方便且有视觉引导」
//   落点=#mem-settings-strip（index.html，记忆内容子tab下方，文件树/表格上方），显隐随 _showMemContentSub。
//   数据源=后端 verb getRetrievalConfig/saveRetrievalConfig（config.retrieval 真键，setDataActions.mjs:4606/4611）。
//   禁硬编码：chip 当前值全部读后端真值渲染；无后端读接口的项（排序/每页/时间戳）不做，避免前端造数据。
//   克制：只放真高频 3 项（自动触发 toggle / 引用聊天条数 / 记忆AI最大搜索轮数），防信息拥挤；
//        其余检索项（分模式条数/超时）保留原「检索配置」面板入口(_loadMemToolRetrieval)不动。
// ============================================================

// chip 表：读/写全部映射到 config.retrieval 真实字段。type=toggle(布尔)/number(整数)。
// 选择依据：这 3 项是记忆检索AI最常调的开关+两个核心数值（对照 _loadMemToolRetrieval 面板里前 3 个最上方控件）；
// min/默认值与检索面板(_loadMemToolRetrieval :585-590)保持一致，避免两处口径漂移。
const _MEM_STRIP_ITEMS = [
  { key: "auto_trigger", type: "toggle", label: "P1自动触发", def: false, title: "P1 检索是否自动触发" },
  { key: "chat_history_count", type: "number", label: "引用条数", def: 5, min: 0, title: "引用聊天条数（默认）" },
  { key: "max_search_rounds", type: "number", label: "搜索轮数", def: 5, min: 1, title: "记忆AI最大搜索轮数" },
];

let _memStripConfig = null; // 后端读回的 config.retrieval 快照（保存后局部更新，供再次展开取真值）
let _memStripInited = false;

async function initMemSettingsStrip() {
  const strip = document.getElementById("mem-settings-strip");
  if (!strip || _memStripInited) return;
  _memStripInited = true;
  // 首次渲染骨架（值待后端返回后填），避免闪烁；读失败给可重试提示，不吞错。
  strip.innerHTML = `<div class="mem-strip-inner"><span class="mem-strip-hint">加载设置...</span></div>`;
  await _refreshMemStrip();
}

// 从后端拉 config.retrieval 真值并渲染 chip（无接口的项不渲染）
async function _refreshMemStrip() {
  const strip = document.getElementById("mem-settings-strip");
  if (!strip) return;
  const charId = getCharId() || ""; // P4c：单源（原 DOM 读法会把占位文案"未加载角色"当 charId，同 _loadMemToolTable 根修）
  if (!charId) {
    strip.innerHTML = `<div class="mem-strip-inner"><span class="mem-strip-hint">选择角色卡后显示设置</span></div>`;
    return;
  }
  try {
    // 后端契约 setDataActions.mjs:4606 getRetrievalConfig → { success, config:retrieval }
    // ★ 单源一致：与「更多设置」面板 _loadMemToolRetrieval:579 同口径——不传 charName（后端落 _global），
    //   读写同一份 config.retrieval，避免 chip 与面板值分裂（后端 charName 缺省=_global，setDataActions.mjs:781）。
    const data = await sendAction({ verb: "getRetrievalConfig", target: "plugins:beilu-memory", source: "web" });
    _memStripConfig = (data && data.config) ? data.config : {};
    _renderMemStrip();
  } catch (e) {
    strip.innerHTML = `<div class="mem-strip-inner"><span class="mem-strip-hint text-error">设置读取失败: ${_escHtml(e.message)}</span><button class="mem-strip-retry" id="mem-strip-retry">重试</button></div>`;
    strip.querySelector("#mem-strip-retry")?.addEventListener("click", () => _refreshMemStrip());
  }
}

function _renderMemStrip() {
  const strip = document.getElementById("mem-settings-strip");
  if (!strip) return;
  const cfg = _memStripConfig || {};
  const chips = _MEM_STRIP_ITEMS.map(it => {
    const cur = cfg[it.key];
    if (it.type === "toggle") {
      const on = cur === undefined ? it.def : !!cur;
      return `<div class="mem-strip-chip" title="${_escHtml(it.title)}">
        <span class="mem-strip-label">${_escHtml(it.label)}</span>
        <span class="mem-strip-toggle${on ? " on" : ""}" role="switch" aria-checked="${on}" data-strip-toggle="${it.key}"></span>
      </div>`;
    }
    // number：chip 显示当前值，点击值就地变为 input（展开改）
    const val = cur === undefined ? it.def : cur;
    return `<div class="mem-strip-chip" title="${_escHtml(it.title)}">
      <span class="mem-strip-label">${_escHtml(it.label)}</span>
      <span class="mem-strip-value" data-strip-num="${it.key}">${_escHtml(val)}</span>
    </div>`;
  }).join("");
  strip.innerHTML = `<div class="mem-strip-inner">${chips}
    <button class="mem-strip-more" id="mem-strip-more" title="打开完整检索配置面板">更多设置 ›</button>
  </div>`;

  // toggle：点击就地切换 + 立即写后端
  strip.querySelectorAll("[data-strip-toggle]").forEach(el => {
    el.addEventListener("click", async () => {
      const key = el.dataset.stripToggle;
      const next = !el.classList.contains("on");
      el.classList.toggle("on", next);
      el.setAttribute("aria-checked", String(next));
      await _saveMemStripPatch({ [key]: next });
    });
  });

  // number：点击值 → 就地变 input，回车/失焦保存（就地展开改，照方案B）
  strip.querySelectorAll("[data-strip-num]").forEach(el => {
    el.addEventListener("click", () => {
      if (el.querySelector("input")) return; // 已在编辑
      const key = el.dataset.stripNum;
      const meta = _MEM_STRIP_ITEMS.find(m => m.key === key) || {};
      const oldVal = el.textContent.trim();
      const inp = document.createElement("input");
      inp.type = "number"; inp.className = "mem-strip-input"; inp.value = oldVal;
      if (meta.min !== undefined) inp.min = String(meta.min);
      el.textContent = ""; el.appendChild(inp); inp.focus(); inp.select();
      let done = false;
      const commit = async (save) => {
        if (done) return; done = true;
        if (!save) { el.textContent = oldVal; return; }
        let v = parseInt(inp.value, 10);
        if (!Number.isFinite(v)) v = parseInt(oldVal, 10) || meta.def || 0;
        if (meta.min !== undefined && v < meta.min) v = meta.min; // 值域下限用后端面板同口径 min，非魔数
        el.textContent = String(v);
        await _saveMemStripPatch({ [key]: v });
      };
      inp.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") { ev.preventDefault(); commit(true); }
        else if (ev.key === "Escape") { ev.preventDefault(); commit(false); }
      });
      inp.addEventListener("blur", () => commit(true));
    });
  });

  // 「更多设置」：跳到完整「检索配置」面板（原入口不动，只做导航），复用现有 diagretr 子tab 路由
  strip.querySelector("#mem-strip-more")?.addEventListener("click", () => {
    const st = document.getElementById("mem-diagretr-subtabs");
    // 显示检索/诊断面板 → 检索子tab（_showDiagretrSub 已处理面板互斥）
    if (st) { document.querySelectorAll(".mem-subtab-bar").forEach(b => { b.style.display = "none"; }); st.style.display = "flex"; }
    _showDiagretrSub("retrieval");
  });
}

// 保存链：镜像检索面板 saveRetrievalConfig 保存路径（setDataActions.mjs:4611），写 config.retrieval 真键。
// 失败 toast 不吞错（_beiluToast 签名 = (msg, level) 见本文件 skills 保存 :235/:239）。
async function _saveMemStripPatch(patch) {
  try {
    // 后端 saveRetrievalConfig 接受 { config:<retrieval patch> }，merge 进 config.retrieval（setDataActions.mjs:4617-4619）
    // ★ 与读侧+检索面板同口径：不传 charName（落 _global），保存到与「更多设置」面板同一份 config.retrieval。
    const data = await sendAction({ verb: "saveRetrievalConfig", target: "plugins:beilu-memory", source: "web", payload: { config: patch } });
    if (data && data.success === false) throw new Error(data.error || "保存失败");
    // 后端回传最新 retrieval，更新本地快照防再次展开取过期值
    if (data && data.config) _memStripConfig = data.config;
    else _memStripConfig = { ...(_memStripConfig || {}), ...patch };
    window._beiluToast?.("设置已保存", "success");
  } catch (e) {
    window._beiluToast?.("设置保存失败: " + e.message, "error");
    // 保存失败回读后端真值重渲染，防 UI 与后端不一致（不吞错，用户可见 toast + UI 复位）
    _refreshMemStrip();
  }
}

// 懒加载记忆工具主区（单一权威：toolbar 旧入口 + 活动栏 3 层入口共用）
function _lazyLoadMemTool(tool, target) {
  if (tool === "table") _loadMemToolTable(target);
  else if (tool === "diag") _loadMemToolDiag(target);
  else if (tool === "snapshot") _loadMemToolSnapshot(target);
  else if (tool === "retrieval") _loadMemToolRetrieval(target);
  else if (tool === "format") _loadMemToolFormat(target);
  else if (tool === "pseries") _loadMemToolPseries(target); // T006: vocab 分支已删（空实现占位，词库面板已移除）
  // skills 分支已删（凛倾 0723「记忆那边直接删除」）：说明书库整块迁 panels/settings/skillLibrary.mjs，
  // 唯一入口=INJ 编辑面板「说明书库」子 tab；记忆 activity 按钮/容器同批删（index.html）。
}


// ★ 记忆 3 层重做：活动栏(层1) data-mem-panel → 主区互斥切换(层2列表+层3详情在各功能视图内部)。
//   chat→#mem-chat-view（对话台），tree→#mem-file-view（文件树+查看），其余→#mem-tool-panel 内对应 .mem-tool-view。
//   互斥隐藏三大主区，根治"对话台与工具面板上下堆叠"。
// 合并 v4 #21：合并面板的当前子视图（内容=文件树/表格；检索诊断=诊断/检索），子tab 切换复用既有路由
let _memContentSub = "tree";
let _diagretrSub = "diag";
let _opsSub = "snapshot";

function _toggleMemMainArea(panelName) {
  const chatView = document.getElementById("mem-chat-view");
  const fileView = document.getElementById("mem-file-view");
  const toolPanel = document.getElementById("mem-tool-panel");
  const sidebar = document.getElementById("mem-sidebar");
  const memToolbar = document.getElementById("mem-toolbar");
  if (chatView) chatView.style.display = "none";
  if (fileView) fileView.style.display = "none";
  if (toolPanel) toolPanel.style.display = "none";
  // T040a 就地设置条：只属「记忆内容」面板（文件树/表格上方常驻），切他面板先隐藏，content 分支再显示
  const _memStrip = document.getElementById("mem-settings-strip");
  if (_memStrip) _memStrip.style.display = "none";
  // 隐藏所有合并面板子tab条，下方按当前面板单独显示对应一条
  document.querySelectorAll(".mem-subtab-bar").forEach((b) => { b.style.display = "none"; });
  // P2-P9 运行切换条（#mem-toolbar-presets）只属对话台：运行预设整理记忆是 chat 面板的事，
  // 预设的编辑统一在 🧠P系列 面板 → 去重，不再两处都显预设。
  if (memToolbar) memToolbar.style.display = panelName === "chat" ? "" : "none";

  // 「记忆内容」合并面板：按当前子tab 显示 文件树 或 表格（各自复用既有路由）
  if (panelName === "content") {
    const st = document.getElementById("mem-content-subtabs");
    if (st) st.style.display = "flex";
    // T040a 就地设置条：记忆内容面板下才显示（表格/文件树上方常驻可见）；显示时刷新真值
    if (_memStrip) { _memStrip.style.display = ""; _refreshMemStrip(); }
    _showMemContentSub(_memContentSub || "tree");
    return;
  }
  // 「检索/诊断」合并面板：诊断 / 检索（自驱动P1 占位已在 diag/retrieval 视图内），均为 toolPanel 内 .mem-tool-view
  if (panelName === "diagretr") {
    const st = document.getElementById("mem-diagretr-subtabs");
    if (st) st.style.display = "flex";
    if (sidebar) sidebar.style.display = "none";
    _showDiagretrSub(_diagretrSub || "diag");
    return;
  }
  // 「记忆运维」合并面板：快照 / 格式（+后续 归档/导入导出），均为 toolPanel 内 .mem-tool-view
  if (panelName === "ops") {
    const st = document.getElementById("mem-ops-subtabs");
    if (st) st.style.display = "flex";
    if (sidebar) sidebar.style.display = "none";
    _showOpsSub(_opsSub || "snapshot");
    return;
  }

  // 侧边栏（层2文件树）只在 tree 功能显示
  if (sidebar) sidebar.style.display = panelName === "tree" ? "" : "none";

  if (panelName === "chat") {
    if (chatView) chatView.style.display = "";
    return;
  }
  if (panelName === "tree") {
    if (fileView) fileView.style.display = "";
    return;
  }
  const target = document.getElementById(`mem-tool-${panelName}-view`);
  if (!target) {
    // 面板视图不存在（如面板被移除后 layoutState 仍存旧值：skills 0723 迁出案）：
    // 回退默认对话台，防"工具主区显示但全视图 hidden"的空白死面板
    if (memToolbar) memToolbar.style.display = "";
    if (chatView) chatView.style.display = "";
    return;
  }
  if (toolPanel) toolPanel.style.display = "";
  toolPanel?.querySelectorAll(".mem-tool-view").forEach((v) => v.classList.add("hidden"));
  target.classList.remove("hidden");
  _lazyLoadMemTool(panelName, target);
}

// 「记忆内容」子tab 切换：文件树(#mem-file-view+侧栏) ↔ 表格(#mem-tool-table-view)，复用各自既有加载
function _showMemContentSub(sub) {
  _memContentSub = sub === "table" ? "table" : "tree";
  const chatView = document.getElementById("mem-chat-view");
  const fileView = document.getElementById("mem-file-view");
  const toolPanel = document.getElementById("mem-tool-panel");
  const sidebar = document.getElementById("mem-sidebar");
  const treePanel = document.getElementById("mem-panel-memory-tree");
  document.querySelectorAll("#mem-content-subtabs .mem-csub-btn").forEach((b) => {
    b.classList.toggle("mem-csub-active", b.dataset.contentSub === _memContentSub);
  });
  if (chatView) chatView.style.display = "none";
  if (fileView) fileView.style.display = "none";
  if (toolPanel) toolPanel.style.display = "none";
  if (_memContentSub === "table") {
    if (sidebar) sidebar.style.display = "none";
    if (treePanel) treePanel.classList.add("hidden");
    if (toolPanel) toolPanel.style.display = "";
    toolPanel?.querySelectorAll(".mem-tool-view").forEach((v) => v.classList.add("hidden"));
    const t = document.getElementById("mem-tool-table-view");
    if (t) t.classList.remove("hidden");
    _lazyLoadMemTool("table", t);
  } else {
    if (sidebar) sidebar.style.display = "";
    if (treePanel) treePanel.classList.remove("hidden");
    if (fileView) fileView.style.display = "";
  }
}

// 「检索/诊断」子tab 切换：诊断/检索（自驱动P1 占位本就在 diag/retrieval 视图内，不另设面板），复用既有 loader
function _showDiagretrSub(sub) {
  _diagretrSub = ["diag", "retrieval"].includes(sub) ? sub : "diag";
  const toolPanel = document.getElementById("mem-tool-panel");
  document.querySelectorAll("#mem-diagretr-subtabs .mem-csub-btn").forEach((b) => {
    b.classList.toggle("mem-csub-active", b.dataset.diagretrSub === _diagretrSub);
  });
  if (toolPanel) toolPanel.style.display = "";
  toolPanel?.querySelectorAll(".mem-tool-view").forEach((v) => v.classList.add("hidden"));
  const t = document.getElementById(`mem-tool-${_diagretrSub}-view`);
  if (t) {
    t.classList.remove("hidden");
    _lazyLoadMemTool(_diagretrSub, t);
  }
}

// 「记忆运维」子tab 切换：快照 / 格式 / 导入导出（归档子tab已删——T5 2026-07-07 凛倾拍板）
function _showOpsSub(sub) {
  _opsSub = ["snapshot", "format", "io"].includes(sub) ? sub : "snapshot";
  const toolPanel = document.getElementById("mem-tool-panel");
  document.querySelectorAll("#mem-ops-subtabs .mem-csub-btn").forEach((b) => {
    b.classList.toggle("mem-csub-active", b.dataset.opsSub === _opsSub);
  });
  if (toolPanel) toolPanel.style.display = "";
  toolPanel?.querySelectorAll(".mem-tool-view").forEach((v) => v.classList.add("hidden"));
  const t = document.getElementById(`mem-tool-${_opsSub}-view`);
  if (t) {
    t.classList.remove("hidden");
    _lazyLoadMemTool(_opsSub, t);
  }
}

// T6b：MEM_API/MEM_GET 常量已随 apiFetch 收口删除——所有出向改走 sendAction 门面（memory 通配 + getData 桥路由）。

// MEM-T6: 记忆表格改 WYSIWYG (复用 dataTable.mjs)
// P4c（2026-07-05 凛倾实测死面板根修）：charId 改读 sharedState.getCharId() 单源（charinfo 加载成功即 setCharId 喂入），
//   废弃原 DOM 读法——dataset.charId 从未被成功分支写入恒空，textContent 兜底会把 index.html 占位文案
//   "未加载角色"当 charId 传给 initDataTable → 后端查无此卡 → 默认表骨架+全面板死按钮（002 新用户实测截图）。
//   配套：监听 beilu:char-changed 复位 _loaded 并在可见时自动重载（原一次性缓存导致角色加载完也不刷新）。
let _memToolTableContainer = null;
let _memToolTableSeq = 0; // [0716 竞态修] _loadMemToolTable 加载序号（见函数内注释）
// _memToolSkillsContainer 已删（0723 说明书库迁 skillLibrary.mjs，char-changed 重载登记随迁该模块）
window.addEventListener("beilu:char-changed", () => {
  for (const [c, loader] of [[_memToolTableContainer, _loadMemToolTable]]) {
    if (!c) continue;
    c._loaded = false;
    if (c.isConnected && c.offsetParent !== null) loader(c); // 可见才即时重载，隐藏时等下次打开
  }
  // chip 常驻条（T040a）同刷：显示中则按新角色卡重拉真值
  const strip = document.getElementById("mem-settings-strip");
  if (strip && strip.style.display !== "none") _refreshMemStrip();
});
async function _loadMemToolTable(container) {
  if (container._loaded) return;
  container._loaded = true;
  _memToolTableContainer = container;
  // [0716 竞态修] 序号令牌（reqId 同范式）：_loaded 布尔只防重入不防乱序——连切角色 A→B 时
  //   char-changed 已复位 _loaded 让 B 进入，但 A 的慢加载（initDataTable await）完成后仍会把
  //   旧角色表格写回。B 进入时 ++seq，A 的后续写点比对失效丢弃。
  //   已知残余窗口（如实标注）：A 已进入 initDataTable 内部则其 DOM 写不可中断，B 完成后覆盖为准。
  const _seq = ++_memToolTableSeq;
  container.innerHTML = '<p class="p-4 text-sm opacity-50">记忆表格加载中...</p>';
  try {
    // 获取当前 charId（单源，与 memoryai.mjs:118 同范式）
    const charId = getCharId() || "";
    if (!charId) {
      container.innerHTML = '<p class="p-4 text-sm opacity-50">请先选择一个角色卡再查看表格（角色加载完成后会自动刷新）</p>';
      container._loaded = false; // 允许下次重试；beilu:char-changed 到达时自动重载
      return;
    }
    const mod = await import("./dataTable.mjs");
    if (_seq !== _memToolTableSeq) return; // 新一轮加载已启动（切了角色），本轮让位
    container.innerHTML = ""; // 清空
    await mod.initDataTable(container, null, { charId, username: "" });
    if (_seq !== _memToolTableSeq) return; // initDataTable 期间已切角色：新一轮会重写容器，本轮不再挂后续面板
    // data 线路/警告面板（2026-07-16 凛倾拍板从 IDE 侧栏迁入记忆板块 data 表格视图；
    //   框架/问题两块已删=与 code 表 #3/#4 概念重复，线路/警告为独有机制保留）。
    //   挂表格编辑器之后：initDataTable 已覆写 innerHTML，重建时旧面板随之清除，重挂无重复监听。
    try {
      const dsMod = await import("../../shared/widgets/dataSystemPanel.mjs");
      const dsHost = document.createElement("div");
      container.appendChild(dsHost);
      dsMod.initDataSystemPanel(dsHost);
    } catch (dsErr) {
      console.warn("[memtool] data 线路面板挂载失败:", dsErr.message);
    }
  } catch (e) {
    container.innerHTML = `<p class="p-4 text-sm text-error">表格初始化失败: ${e.message}</p>`;
    container._loaded = false;
  }
}

// MEM-T3: AI 诊断面板 (调 getDiagSnapshot + 可读渲染 + 自驱动 P1 统计占位)
async function _loadMemToolDiag(container) {
  container._loaded = true;
  container.innerHTML = `<div class="p-4 space-y-3 text-xs">
    <div class="flex items-center gap-2">
      <span class="font-bold text-sm"><i data-ic="search"></i> AI P1 诊断快照</span>
      <button id="mem-diag-refresh" class="btn btn-xs btn-outline beilu-btn-accent" style="border-color:var(--beilu-amber);color:var(--beilu-amber)"><i data-ic="refresh"></i> 刷新</button>
      <span id="mem-diag-status" class="opacity-50"></span>
    </div>
    <div id="mem-diag-body"></div>
  </div>`;
  const statusEl = container.querySelector("#mem-diag-status");
  const bodyEl = container.querySelector("#mem-diag-body");
  const esc = escapeHtml; // T7：alias 到唯一权威实现（原本地 5 字符 replace 链已删）
  async function doRefresh() {
    statusEl.textContent = "加载中...";
    try {
      // 原 POST setdata {_action:getDiagSnapshot} → memory 通配路由 verb=真动作组装 _action
      const diag = await sendAction({ verb: "getDiagSnapshot", target: "plugins:beilu-memory", source: "web" });
      statusEl.textContent = "";
      const kv = (label, val, badge) => `
        <div class="flex justify-between items-center text-[11px] px-2 py-1 bg-base-300/30 rounded">
          <span class="opacity-70">${esc(label)}</span>
          <span class="flex items-center gap-1">${badge ? `<span class="badge badge-xs ${badge}">${val ? '<i data-ic="check"></i>' : '<i data-ic="cross"></i>'}</span>` : ""}<span class="font-mono">${esc(val)}</span></span>
        </div>`;
      bodyEl.innerHTML = `
        <div class="space-y-1">
          ${kv("插件启用", diag.pluginEnabled ?? "未知", "badge-success")}
          ${kv("auto_trigger", diag.autoTrigger ?? "未知", "badge-success")}
          ${kv("P1 运行中", diag.isP1Running ?? "未知", diag.isP1Running ? "badge-warning" : "badge-ghost")}
          ${kv("P1 缓存", `${diag.hasP1Cache ? "有" : "无"} (${diag.p1CacheLength || 0} 字)`, diag.hasP1Cache ? "badge-success" : "badge-ghost")}
          ${kv("P1 缓存时间", diag.p1CacheTimestamp || "无")}
          ${kv("输出队列", diag.outputQueueLength ?? 0)}
        </div>
        <div class="mt-2 p-2 bg-base-300/30 rounded">
          <div class="text-[10px] opacity-60 mb-1">启用的预设</div>
          <div class="flex flex-wrap gap-1">${(diag.enabledPresets || []).map(p => `<span class="badge badge-xs badge-outline">${esc(p)}</span>`).join("") || '<span class="opacity-50">(无)</span>'}</div>
        </div>
        ${diag.p1CacheContent ? `<details class="mt-2"><summary class="cursor-pointer text-[11px] opacity-70">P1 缓存内容 (${diag.p1CacheLength} 字)</summary>
          <pre class="mt-1 p-2 bg-base-300/30 rounded text-[10px] whitespace-pre-wrap max-h-64 overflow-auto">${esc(diag.p1CacheContent)}</pre>
        </details>` : ""}
        <div class="mt-2 p-2 bg-base-300/30 rounded">
          <div class="text-[10px] opacity-60 mb-1">P系列运行记录（最近 ${(diag.pseriesRuns || []).length} 条）</div>
          ${(diag.pseriesRuns || []).length ? (diag.pseriesRuns || []).map(r => `
            <details class="mb-1">
              <summary class="cursor-pointer text-[11px] flex items-center gap-2">
                <span class="badge badge-xs badge-outline">${esc(r.presetId || "?")}</span>
                <span class="opacity-70">${esc((r.ts || "").replace("T", " ").slice(0, 19))}</span>
                <span class="opacity-50">${esc(r.mode || "")} · ${r.rounds ?? 0}轮 · ${Math.round((r.timeMs || 0) / 1000)}s · ${r.opCount ?? 0}操作 · ${r.replyLen ?? 0}字</span>
              </summary>
              ${(r.ops || []).length ? `<div class="mt-1 pl-2 text-[10px] opacity-70">${(r.ops || []).map(o => `<div>${esc(o.op)} ${esc(o.path || "")} ${esc(o.status || "")}</div>`).join("")}</div>` : ""}
              <pre class="mt-1 p-2 bg-base-300/30 rounded text-[10px] whitespace-pre-wrap max-h-48 overflow-auto">${esc(r.reply || "(空输出)")}</pre>
            </details>`).join("") : '<span class="text-[11px] opacity-50">(暂无记录——P系列每次运行完成后会在此留痕)</span>'}
        </div>
      `;
    } catch (e) { statusEl.textContent = `❌ ${e.message}`; }
  }
  container.querySelector("#mem-diag-refresh")?.addEventListener("click", doRefresh);
  doRefresh();
}

// MEM-T4: 快照管理 — 记忆快照 + Git 快照 两 section
async function _loadMemToolSnapshot(container) {
  container._loaded = true;
  container.innerHTML = `<div class="p-4 space-y-4 text-xs">
    <!-- 记忆快照 -->
    <div class="space-y-2">
      <div class="flex items-center gap-2">
        <span class="font-bold text-sm"><i data-ic="camera"></i> 记忆快照</span>
        <button id="mem-snap-create" class="btn btn-xs btn-outline beilu-btn-accent" style="border-color:var(--beilu-amber);color:var(--beilu-amber)"><i data-ic="plus"></i> 创建新快照</button>
        <span id="mem-snap-status" class="opacity-50"></span>
      </div>
      <div id="mem-snap-list" class="space-y-1"></div>
    </div>
    <!-- Git 快照 -->
    <div class="space-y-2 border-t border-base-300/30 pt-3">
      <div class="flex items-center gap-2">
        <span class="font-bold text-sm"><i data-ic="sprout"></i> Git 快照</span>
        <input id="mem-git-label" type="text" placeholder="标签(可选,如 v1.2-hotfix)" class="input input-xs input-bordered flex-1 max-w-[180px]"/>
        <button id="mem-git-create" class="btn btn-xs btn-outline beilu-btn-accent" style="border-color:var(--beilu-amber);color:var(--beilu-amber)" title="对项目根创建 git 保险快照（stash create，不动工作区）"><i data-ic="plus"></i> 创建 Git 快照</button>
        <span id="mem-git-status" class="opacity-50"></span>
      </div>
      <div id="mem-git-list" class="space-y-1"></div>
    </div>
  </div>`;
  const esc = escapeHtml; // T7：alias 到唯一权威实现（原本地 5 字符 replace 链已删）

  // --- 记忆快照 ---
  async function refreshSnaps() {
    const listEl = container.querySelector("#mem-snap-list");
    const statusEl = container.querySelector("#mem-snap-status");
    if (!listEl) return;
    try {
      // 原 POST setdata {_action:listSnapshots} → memory 通配路由
      const data = await sendAction({ verb: "listSnapshots", target: "plugins:beilu-memory", source: "web" });
      const snaps = data?.snapshots || [];
      if (snaps.length === 0) { listEl.innerHTML = '<div class="opacity-50">暂无记忆快照</div>'; return; }
      listEl.innerHTML = snaps.map(s => `
        <div class="flex items-center gap-2 px-2 py-1 bg-base-300/30 rounded">
          <span class="flex-1 truncate" title="${esc(s.reason || "")}">
            <span class="font-mono text-[10px] opacity-60">${esc(s.id || "")}</span>
            ${s.reason ? `<span class="ml-2">${esc(s.reason)}</span>` : ""}
          </span>
          <span class="opacity-50 text-[10px]">${esc(s.timestamp || s.date || "")}</span>
          <button class="btn btn-xs btn-ghost" data-act="restore" data-id="${esc(s.id)}">↩ 恢复</button>
        </div>`).join("");
      listEl.querySelectorAll("[data-act='restore']").forEach(b => b.addEventListener("click", async () => {
        const snapId = b.dataset.id;
        if (!await beiluConfirm(`恢复到快照 ${snapId} ? (当前状态会被覆盖)`)) return;
        statusEl.textContent = "恢复中...";
        try {
          // 原 POST setdata {_action:restoreSnapshot,...} → memory 通配路由
          const data = await sendAction({ verb: "restoreSnapshot", target: "plugins:beilu-memory", source: "web", payload: { snapshotId: snapId } });
          statusEl.textContent = data.success ? "✅ 已恢复" : `❌ ${data.error}`;
          setTimeout(() => { statusEl.textContent = ""; }, 3000);
        } catch (e) { statusEl.textContent = `❌ ${e.message}`; }
      }));
    } catch (e) { listEl.innerHTML = `<div class="text-error">${esc(e.message)}</div>`; }
  }

  container.querySelector("#mem-snap-create")?.addEventListener("click", async () => {
    const reason = await beiluPrompt("快照说明 (可选):") || "手动创建";
    const statusEl = container.querySelector("#mem-snap-status");
    statusEl.textContent = "创建中...";
    try {
      // 原 POST setdata {_action:createSnapshot,...} → memory 通配路由
      const data = await sendAction({ verb: "createSnapshot", target: "plugins:beilu-memory", source: "web", payload: { reason } });
      statusEl.textContent = data.success ? "✅ 已创建" : `❌ ${data.error || "失败"}`;
      setTimeout(() => { statusEl.textContent = ""; }, 3000);
      refreshSnaps();
    } catch (e) { statusEl.textContent = `❌ ${e.message}`; }
  });

  // --- Git 快照 (只列) ---
  // 缺-7：当前角色卡 = checkpoint 作用域（带 cardKey → 后端按该卡 repo 快照/回档 + 列表过滤，防 A 卡回档碰 B 卡）；
  //   空 cardKey = 旧全局行为，向后兼容。cardKey=charName（后端 getCardWorkspaceRoot 按 charName 解析卡根）。
  const _ckCard = () => window._beiluGetCharName?.() || storage.get(KEYS.BEILU_LAST_CHAR) || "";
  async function refreshGit() {
    const listEl = container.querySelector("#mem-git-list");
    if (!listEl) return;
    try {
      // 原 POST setdata {_action:listGitCheckpoints,...} → memory 通配路由
      const data = await sendAction({ verb: "listGitCheckpoints", target: "plugins:beilu-memory", source: "web", payload: { cardKey: _ckCard() } });
      const cks = data?.checkpoints || [];
      if (cks.length === 0) { listEl.innerHTML = '<div class="opacity-50">暂无 Git 快照</div>'; return; }
      listEl.innerHTML = cks.map(c => `
        <div class="flex items-center gap-2 px-2 py-1 bg-base-300/30 rounded">
          <span class="flex-1 truncate">${esc(c.label || c.id || "")}</span>
          <span class="opacity-50 text-[10px]">${esc(c.timestamp || c.date || "")}</span>
          <button class="btn btn-xs btn-ghost" data-git-act="restore" data-id="${esc(c.id)}">↩ 恢复</button>
        </div>`).join("");
      listEl.querySelectorAll("[data-git-act='restore']").forEach(b => b.addEventListener("click", async () => {
        const cid = b.dataset.id;
        if (!await beiluConfirm(`Git 恢复到 ${cid} ?\n\n将 reset 项目根到该快照 HEAD 并应用其改动层；恢复前会自动留一个 pre-restore 保险快照。`)) return;
        const statusEl = container.querySelector("#mem-git-status");
        statusEl.textContent = "恢复中...";
        try {
          // 原 POST setdata {_action:gitRestore,...} → memory 通配路由
          const data = await sendAction({ verb: "gitRestore", target: "plugins:beilu-memory", source: "web", payload: { checkpointId: cid, cardKey: _ckCard() } });
          statusEl.textContent = data.success ? `✅ ${(data.results || []).join(", ") || "已恢复"}` : `❌ ${data.error}`;
          setTimeout(() => { statusEl.textContent = ""; }, 5000);
        } catch (e) { statusEl.textContent = `❌ ${e.message}`; }
      }));
    } catch (e) { listEl.innerHTML = `<div class="text-error">${esc(e.message)}</div>`; }
  }

  // N43: 创建 Git 快照（后端真名 gitSnapshot；已修正为 stash create 零动工作区）
  container.querySelector("#mem-git-create")?.addEventListener("click", async () => {
    const statusEl = container.querySelector("#mem-git-status");
    const label = container.querySelector("#mem-git-label")?.value?.trim() || "";
    statusEl.textContent = "创建中...";
    try {
      // 原 POST setdata {_action:gitSnapshot,...} → memory 通配路由
      const data = await sendAction({ verb: "gitSnapshot", target: "plugins:beilu-memory", source: "web", payload: { label, reason: "manual", cardKey: _ckCard() } });
      statusEl.textContent = data?.success ? `✅ ${data.checkpoint?.stashResult || "已创建"}` : `❌ ${data?.error || "创建失败"}`;
      setTimeout(() => { statusEl.textContent = ""; }, 5000);
      if (data?.success) refreshGit();
    } catch (e) { statusEl.textContent = `❌ ${e.message}`; }
  });

  refreshSnaps();
  refreshGit();
}

async function _loadMemToolRetrieval(container) {
  if (container._loaded) return;
  container._loaded = true;
  try {
    // N41: 读写统一走 config.retrieval 真键（getRetrievalConfig/saveRetrievalConfig 对称）。
    // 旧面板的 BM25 四参数是读死键 p1_config 的假 UI（后端零消费）已删；
    // BM25 算法常量在 p1_node8_10_blq.mjs CFG（实验定），不开放面板修改。
    // 原 POST setdata {_action:getRetrievalConfig} → memory 通配路由
    const data = await sendAction({ verb: "getRetrievalConfig", target: "plugins:beilu-memory", source: "web" });
    const rc = data?.config || {};
    container.innerHTML = `<div class="p-4 space-y-4 text-xs">
      <!-- 检索/记忆AI 真实配置 (config.retrieval) -->
      <div class="space-y-2">
        <div class="font-bold text-sm"><i data-ic="search"></i> 检索配置</div>
        <label class="flex items-center gap-2"><input type="checkbox" id="mem-ret-auto" class="toggle toggle-xs" ${rc.auto_trigger ? "checked" : ""}/><span>P1 检索自动触发</span></label>
        <!-- T6-C8: 删前端编造副本(5/10/60000)。后端 getRetrievalConfig 回包恒含 config.retrieval 块，
             回填后端真值；请求失败走 catch 显示 error，字段缺失则 ?? '' 留空(同 web slot 范式)，不编造假值。 -->
        <label class="flex items-center gap-2"><span class="opacity-60 w-36">引用聊天条数(默认)</span><input type="number" min="0" id="mem-ret-hist" class="input input-xs input-bordered flex-1" value="${rc.chat_history_count ?? ''}"/></label>
        <label class="flex items-center gap-2"><span class="opacity-60 w-36">· chat 模式条数</span><input type="number" min="0" id="mem-ret-hist-chat" class="input input-xs input-bordered flex-1" value="${rc.chat_history_count_chat ?? ''}"/></label>
        <label class="flex items-center gap-2"><span class="opacity-60 w-36">· code 模式条数</span><input type="number" min="0" id="mem-ret-hist-code" class="input input-xs input-bordered flex-1" value="${rc.chat_history_count_code ?? ''}"/></label>
        <label class="flex items-center gap-2"><span class="opacity-60 w-36">· work 模式条数</span><input type="number" min="0" id="mem-ret-hist-work" class="input input-xs input-bordered flex-1" value="${rc.chat_history_count_work ?? ''}"/></label>
        <label class="flex items-center gap-2"><span class="opacity-60 w-36">记忆AI最大搜索轮数</span><input type="number" min="1" id="mem-ret-rounds" class="input input-xs input-bordered flex-1" value="${rc.max_search_rounds ?? ''}"/></label>
        <label class="flex items-center gap-2"><span class="opacity-60 w-36">超时(毫秒)</span><input type="number" min="1000" step="1000" id="mem-ret-timeout" class="input input-xs input-bordered flex-1" value="${rc.timeout_ms ?? ''}"/></label>
        <button id="mem-ret-save" class="btn btn-xs btn-outline beilu-btn-accent" style="border-color:var(--beilu-amber);color:var(--beilu-amber)"><i data-ic="save"></i> 保存</button>
        <span id="mem-ret-save-status" class="text-xs opacity-50 ml-2"></span>
        <div class="text-[10px] opacity-50">BM25/置信度等算法参数为管线实验常量（p1_node8_10_blq CFG），不在此配置。</div>
      </div>

    </div>`;
    // 保存按钮（N41: 只发真实消费字段，包成 config 对象——后端不再吞 _action）
    container.querySelector("#mem-ret-save")?.addEventListener("click", async () => {
      // T6-C8: 保存跳空——输入框留空则不提交该字段(后端保留原值/兜底)，删前端编造副本 dft(5/10/60000)。同 web slot 范式。
      const newRc = { auto_trigger: !!container.querySelector("#mem-ret-auto")?.checked };
      const _put = (sel, key) => {
        const raw = container.querySelector(sel)?.value?.trim();
        if (raw !== "" && raw != null) { const v = Number(raw); if (Number.isFinite(v)) newRc[key] = v; }
      };
      _put("#mem-ret-hist", "chat_history_count");
      _put("#mem-ret-hist-chat", "chat_history_count_chat");
      _put("#mem-ret-hist-code", "chat_history_count_code");
      _put("#mem-ret-hist-work", "chat_history_count_work");
      _put("#mem-ret-rounds", "max_search_rounds");
      _put("#mem-ret-timeout", "timeout_ms");
      try {
        // 原 POST setdata {_action:saveRetrievalConfig, config} → memory 通配路由
        const saveData = await sendAction({ verb: "saveRetrievalConfig", target: "plugins:beilu-memory", source: "web", payload: { config: newRc } });
        const statusEl = container.querySelector("#mem-ret-save-status");
        if (statusEl) statusEl.textContent = saveData?.success ? "✅ 已保存" : `❌ ${saveData?.error || "保存失败"}`;
        setTimeout(() => { if (statusEl) statusEl.textContent = ""; }, 3000);
      } catch (e) {
        const statusEl = container.querySelector("#mem-ret-save-status");
        if (statusEl) statusEl.textContent = `❌ ${e.message}`;
      }
    });
  } catch (e) { container.innerHTML = `<p class="p-4 text-sm text-error">${e.message}</p>`; }
}

// ============================================================
// MEM-T8: 记忆条目格式检查/升级 (P1 自驱动前置)
// ============================================================
async function _loadMemToolFormat(container) {
  container._loaded = true;
  container.innerHTML = `<div class="p-4 space-y-3 text-xs">
    <div class="flex items-center gap-2">
      <span class="font-bold text-sm"><i data-ic="check"></i> 记忆条目格式检查</span>
      <button id="mem-fmt-scan" class="btn btn-xs btn-outline beilu-btn-accent" style="border-color:var(--beilu-amber);color:var(--beilu-amber)"><i data-ic="search"></i> 扫描</button>
      <button id="mem-fmt-upgrade" class="btn btn-xs btn-outline btn-warning" disabled>⬆️ 一键升级</button>
      <span id="mem-fmt-status" class="opacity-50"></span>
    </div>
    <div class="text-[11px] opacity-70">
      统一格式: <code>{timestamp, keywords, content, keyword_nodes, type, weight}</code><br/>
      旧格式 (forever 的 event+date / appointments 的 character+task) 读取时自动补全,归档时规范化。
      不符合会标记为 warning/error。
    </div>
    <div id="mem-fmt-summary"></div>
    <div id="mem-fmt-files"></div>
    <div id="mem-fmt-issues"></div>
  </div>`;

  const scanBtn = container.querySelector("#mem-fmt-scan");
  const upgradeBtn = container.querySelector("#mem-fmt-upgrade");
  const statusEl = container.querySelector("#mem-fmt-status");
  const summaryEl = container.querySelector("#mem-fmt-summary");
  const filesEl = container.querySelector("#mem-fmt-files");
  const issuesEl = container.querySelector("#mem-fmt-issues");

  async function doScan() {
    statusEl.textContent = "扫描中...";
    summaryEl.innerHTML = filesEl.innerHTML = issuesEl.innerHTML = "";
    try {
      // 原 POST setdata {_action:checkMemoryFormat} → memory 通配路由
      const data = await sendAction({ verb: "checkMemoryFormat", target: "plugins:beilu-memory", source: "web" });
      if (!data.success) { statusEl.textContent = `❌ ${data.error}`; return; }
      statusEl.textContent = "";
      summaryEl.innerHTML = `
        <div class="grid grid-cols-4 gap-2">
          <div class="p-2 bg-success/10 rounded"><div class="text-lg font-bold">${data.valid}</div><div class="text-[10px] opacity-60">符合新格式</div></div>
          <div class="p-2 bg-warning/10 rounded"><div class="text-lg font-bold">${data.warnings}</div><div class="text-[10px] opacity-60">有警告 (缺推荐字段)</div></div>
          <div class="p-2 bg-error/10 rounded"><div class="text-lg font-bold">${data.invalid}</div><div class="text-[10px] opacity-60">错误 (缺必填)</div></div>
          <div class="p-2 bg-base-300/50 rounded"><div class="text-lg font-bold">${data.total}</div><div class="text-[10px] opacity-60">总条目</div></div>
        </div>`;
      if (data.files.length > 0) {
        filesEl.innerHTML = `<div class="mt-3">
          <div class="font-semibold mb-1"><i data-ic="folder-open"></i> 按文件统计 (${data.files.length})</div>
          <div class="space-y-0.5 max-h-48 overflow-y-auto">${data.files.map(f => `
            <div class="flex justify-between items-center text-[11px] px-2 py-1 bg-base-300/30 rounded">
              <span class="font-mono truncate" title="${_escHtml(f.file)}">${_escHtml(f.file)}</span>
              <span class="flex gap-1">
                ${f.valid > 0 ? `<span class="badge badge-xs bg-success/30 text-success-content">${f.valid} <i data-ic="check"></i></span>` : ""}
                ${f.warnings > 0 ? `<span class="badge badge-xs bg-warning/30">${f.warnings} <i data-ic="warning"></i></span>` : ""}
                ${f.invalid > 0 ? `<span class="badge badge-xs bg-error/30 text-error-content">${f.invalid} <i data-ic="cross"></i></span>` : ""}
              </span>
            </div>`).join("")}</div>
        </div>`;
      }
      if (data.issues.length > 0) {
        const show = data.issues.slice(0, 20);
        issuesEl.innerHTML = `<div class="mt-3">
          <div class="font-semibold mb-1"><i data-ic="search"></i> 问题清单 (前 ${show.length} / 共 ${data.issues.length})</div>
          <div class="space-y-1 max-h-64 overflow-y-auto text-[11px]">${show.map(it => `
            <div class="p-1.5 rounded ${it.level === "error" ? "bg-error/10" : "bg-warning/10"}">
              <div><span class="font-mono opacity-70">${_escHtml(it.file)}${it.index !== undefined ? `[${it.index}]` : ""}</span></div>
              ${it.errors?.length ? `<div class="opacity-80 text-error"><i data-ic="cross"></i> ${_escHtml(it.errors.join(" / "))}</div>` : ""}
              ${it.warnings?.length ? `<div class="opacity-70"><i data-ic="warning"></i> ${_escHtml(it.warnings.join(" / "))}</div>` : ""}
            </div>`).join("")}</div>
        </div>`;
        upgradeBtn.disabled = false;
      } else {
        upgradeBtn.disabled = true;
      }
    } catch (e) { statusEl.textContent = `❌ ${e.message}`; }
  }

  scanBtn?.addEventListener("click", doScan);
  upgradeBtn?.addEventListener("click", async () => {
    if (!await beiluConfirm("确认一键升级所有不符合格式的条目? (归档文件就地改写,建议先创建快照)")) return;
    statusEl.textContent = "升级中...";
    try {
      // 原 POST setdata {_action:upgradeMemoryFormat} → memory 通配路由
      const data = await sendAction({ verb: "upgradeMemoryFormat", target: "plugins:beilu-memory", source: "web" });
      if (data.success) {
        statusEl.textContent = `✅ 升级了 ${data.filesChanged} 个文件 / ${data.entriesChanged} 条记忆`;
        await doScan(); // 刷新
      } else {
        statusEl.textContent = `❌ ${data.error}`;
      }
    } catch (e) { statusEl.textContent = `❌ ${e.message}`; }
  });
  // 自动扫一次
  doScan();
}

// T006死码批: _loadMemToolVocab 空占位函数与 vocab 分发分支已删（词库面板早已移除）。

// ============================================================
// ED-T4: P系列引擎编辑 (P1-P8)
//   左列表(预设名) + 右详情(提示词 + 模型 + 运行)
//   后端 action: getMemoryPresets / getMemoryPresetDetail / updateMemoryPreset / runMemoryPreset
// ============================================================
let _pseriesLoaded = false;
let _pseriesData = null;
let _pseriesSelected = null;
// 记忆视图内的"查看模式"：决定编辑/保存哪一套提示词组（prompts/prompts_code/prompts_work）。
// 纯视图过滤，不动会话 live 态——修"切换模式却改了当前状态"。
let _pseriesViewMode = "chat";
const _PSERIES_SETKEY = { chat: "prompts", code: "prompts_code", work: "prompts_work" };
// 提示词条目工作副本：编辑暂存在这里，「保存预设」时整组 replacePresetPrompts 写回（添加/删除即时持久化）
let _pseriesPrompts = [];
let _pseriesPromptSel = null;
let _pseriesAISourceNames = null; // getAISources 结果缓存（面板生命周期内一次）
let _pseriesModelReqId = 0; // 模型列表拉取竞态票据（同 subModePanel _modelSelectReqId）
let _pseriesEnumSchema = null; // getSubModes 下发 enum_schema 缓存（权威=后端 paramSchema.mjs ENUM_SCHEMA）
// 0715 V3 收口：离线退化副本（原 _PSERIES_ENUM_FALLBACK，与 subModePanel 三表等值双写）
// 并入 shared/state/enumFallback.mjs 单源，此处改 import 消费（值/文案一字未改）。
const _pseriesEnumOpts = (key) => {
  const fromSchema = _pseriesEnumSchema?.[key]?.options;
  return Array.isArray(fromSchema) && fromSchema.length ? fromSchema : ENUM_FALLBACK[key];
};
async function _loadMemToolPseries(container) {
  if (container._loaded) return;
  container._loaded = true;
  container.innerHTML = `<div class="h-full flex text-xs">
    <div class="w-44 shrink-0 border-r border-base-300/40 overflow-y-auto" id="pseries-list">
      <div class="p-2 opacity-50">加载中...</div>
    </div>
    <div class="flex-1 overflow-y-auto p-3" id="pseries-detail">
      <div class="text-center text-base-content/40 py-8">未选择预设。从左侧列表选择后在此处查看/编辑</div>
    </div>
  </div>`;
  try {
    await _refreshPseriesList();
  } catch (e) {
    console.error("[layout] pseries init error:", e);
    window._reportError?.(`[layout] pseries init error: ${e.message}`);
    container._loaded = false;
  }
}

async function _refreshPseriesList() {
  const listEl = document.getElementById("pseries-list");
  if (!listEl) return;
  listEl.innerHTML = '<div class="p-2 opacity-50">加载中...</div>';
  try {
    // 后端 getMemoryPresets action 未返回数据(case 只 break),改走 getdata 拿 memory_presets 数组。
    // 原 raw GET getdata → 复用 memory#getData（桥路由，unwrap 还原裸 config；空 payload→args={}，到达同一 handleGetData）
    const j = await sendAction({ verb: "getData", target: "plugins:beilu-memory", source: "web" }) || {};
    // pp/预填充选项集权威随 getSubModes 下发（paramSchema.mjs ENUM_SCHEMA），单次缓存；失败走离线退化表
    if (!_pseriesEnumSchema) {
      try {
        const _sm = await sendAction({ verb: "getSubModes", target: "plugins:beilu-memory", source: "web" });
        if (_sm?.enum_schema && typeof _sm.enum_schema === "object") _pseriesEnumSchema = _sm.enum_schema;
      } catch (e) { console.warn("[memtool] enum_schema 下发失败，用离线退化选项:", e?.message || e); }
    }
    const arr = Array.isArray(j.memory_presets) ? j.memory_presets : [];
    _pseriesData = {};
    arr.forEach(p => { if (p && p.id) _pseriesData[p.id] = p; });
    // p系列持久激活位恢复（凛倾0706「切换=改绑」）：本面板尚无选中时用后端 active_memory_preset_id
    //   （写点=setActiveMemoryPreset verb，与 memoryPresetChat 面板互通同一存储）；恢复不回写。
    if (!_pseriesSelected && j.active_memory_preset_id && _pseriesData[j.active_memory_preset_id]) {
      _pseriesSelected = j.active_memory_preset_id;
    }
    const ids = Object.keys(_pseriesData);
    if (ids.length === 0) {
      listEl.innerHTML = '<div class="p-2 opacity-50">无预设</div>';
      return;
    }
    listEl.innerHTML = ids.map(id => {
      const p = _pseriesData[id] || {};
      const enabled = p.enabled !== false;
      const active = _pseriesSelected === id;
      return `<div class="pseries-item ${active ? 'bg-warning/20' : ''}" data-pname="${_escapeHtml(id)}" style="padding:8px;border-bottom:1px solid var(--beilu-amber-8);cursor:pointer;">
        <div style="display:flex;align-items:center;gap:6px;">
          <span style="color:${enabled ? 'var(--beilu-success)' : 'var(--beilu-muted, #6b7280)'};">${enabled ? '✓' : '○'}</span>
          <span class="font-mono text-[11px]">${_escapeHtml(id)}</span>
        </div>
        <div class="text-[10px] opacity-50 truncate">${_escapeHtml(p.description || '')}</div>
      </div>`;
    }).join("");
    listEl.querySelectorAll("[data-pname]").forEach(el => {
      el.addEventListener("click", () => _selectPseries(el.dataset.pname, { persist: true })); // 用户点击=改绑（凛倾0706）
    });
    if (_pseriesSelected && _pseriesData[_pseriesSelected]) _selectPseries(_pseriesSelected); // 恢复不 persist
  } catch (e) {
    listEl.innerHTML = `<div class="p-2 text-error">加载失败: ${_escapeHtml(e.message)}</div>`;
  }
}

function _selectPseries(name, opts = {}) {
  _pseriesSelected = name;
  // p系列持久激活位（凛倾0706「切换=改绑」）：仅用户点击 persist 写后端（恢复/重渲染不写，防覆盖）；
  //   fire-and-forget 失败不阻断详情渲染。与 memoryPresetChat selectPreset persist 同语义同 verb。
  if (opts.persist) {
    sendAction({ verb: "setActiveMemoryPreset", target: "plugins:beilu-memory", source: "web", payload: { presetId: name } })
      .catch((e) => console.warn("[memtool] 持久化激活预设失败:", e?.message || e));
  }
  document.querySelectorAll("#pseries-list [data-pname]").forEach(el => {
    el.classList.toggle("bg-warning/20", el.dataset.pname === name);
  });
  const detail = document.getElementById("pseries-detail");
  if (!detail) return;
  const p = _pseriesData[name] || {};
  const _apiCfg = p.api_config || {};
  const _enumOptHtml = (key, cur) => _pseriesEnumOpts(key).map((o) =>
    `<option value="${_escapeHtml(o.value)}" ${o.title ? `title="${_escapeHtml(o.title)}"` : ""} ${cur === o.value ? "selected" : ""}>${_escapeHtml(o.label)}</option>`).join("");
  // ★ 按查看模式取对应提示词组（修后端线路 bug：原来恒取 chat 的 prompts，忽略 prompts_code/prompts_work）
  const _setKey = _PSERIES_SETKEY[_pseriesViewMode] || "prompts";
  const prompts = Array.isArray(p[_setKey]) ? p[_setKey] : [];
  const _vmBtn = (vm, label) =>
    `<button class="btn btn-xs join-item ${_pseriesViewMode === vm ? "btn-warning" : "btn-ghost"}" data-vm="${vm}">${label}</button>`;
  detail.innerHTML = `
    <div class="flex items-center gap-2 mb-2 flex-wrap">
      <span class="text-sm font-bold">${_escapeHtml(name)}</span>
      <span class="badge badge-sm ${p.enabled !== false ? 'badge-success' : 'badge-ghost'}">${p.enabled !== false ? '启用' : '停用'}</span>
      <div class="join ml-auto" id="pseries-viewmode" title="查看/编辑哪一套提示词组（仅过滤视图，不切换会话模式）">
        ${_vmBtn("chat", '<i data-ic="message"></i>聊天')}${_vmBtn("code", '<i data-ic="code"></i>编程')}${_vmBtn("work", '<i data-ic="clipboard"></i>工作')}
      </div>
    </div>
    <div class="text-[10px] opacity-50 mb-2">正在编辑 <b>${_setKey}</b> 提示词组（切上方标签看其它模式；这里不改会话当前模式）</div>
    <label class="flex items-center justify-between mb-2">
      <span>启用</span>
      <input type="checkbox" class="toggle toggle-sm toggle-warning" id="pseries-enabled" ${p.enabled !== false ? 'checked' : ''} />
    </label>
    <label class="block mb-2">
      <span class="block opacity-60 mb-1">描述</span>
      <input type="text" id="pseries-description" class="input input-xs input-bordered w-full" value="${_escapeHtml(p.description || '')}" />
    </label>
    <div class="divider text-[10px] opacity-40 my-2">AI 调用参数</div>
    <div class="flex gap-2 mb-2">
      <label class="flex-1">
        <span class="block opacity-60 mb-1">提示词后处理</span>
        <select id="pseries-pp" class="select select-xs select-bordered w-full">
          ${_enumOptHtml("prompt_post_processing", _apiCfg.prompt_post_processing || "strict")}
        </select>
      </label>
      <label class="flex-1">
        <span class="block opacity-60 mb-1">尾部预填充模式</span>
        <select id="pseries-prefill-mode" class="select select-xs select-bordered w-full">
          <option value="off" ${!_apiCfg.claude_prefill_mode || _apiCfg.claude_prefill_mode === 'off' ? 'selected' : ''} title="不处理尾部消息。渠道若不接受尾部 assistant（如 Claude 系强制 user 结尾）将由 API 返回错误，据此再选择处理模式">关闭（默认不处理）</option>
          ${_enumOptHtml("claude_prefill_mode", _apiCfg.claude_prefill_mode || "off")}
        </select>
      </label>
    </div>
    <label class="flex items-center justify-between mb-2">
      <span title="关闭时使用系统默认AI服务源及其默认模型，下方服务源/模型/温度等参数不生效">自定义 API（关=系统默认源，下列参数不生效）</span>
      <input type="checkbox" id="pseries-use-custom" class="toggle toggle-sm toggle-warning" ${_apiCfg.use_custom ? 'checked' : ''} />
    </label>
    <div id="pseries-custom-fields" class="space-y-2 mb-2">
      <div class="flex gap-2">
        <label class="flex-1">
          <span class="block opacity-60 mb-1">服务源</span>
          <select id="pseries-source" class="select select-xs select-bordered w-full">
            <option value="">（加载中...）</option>
          </select>
        </label>
        <label class="flex-1">
          <span class="block opacity-60 mb-1">绑定模型（可选）</span>
          <select id="pseries-model" class="select select-xs select-bordered w-full">
            <option value="">（使用 API 源默认模型）</option>
          </select>
        </label>
      </div>
      <div class="flex gap-2">
        <label class="flex-1">
          <span class="block opacity-60 mb-1">温度</span>
          <input type="number" id="pseries-temperature" min="0" max="2" step="0.01" placeholder="默认" class="input input-xs input-bordered w-full" value="${_apiCfg.temperature != null ? Number(_apiCfg.temperature) : ''}" />
        </label>
        <label class="flex-1">
          <span class="block opacity-60 mb-1">最大输出</span>
          <input type="number" id="pseries-max-tokens" min="256" max="1000000" step="256" placeholder="默认" class="input input-xs input-bordered w-full" value="${_apiCfg.max_tokens != null ? Number(_apiCfg.max_tokens) : ''}" />
        </label>
        <label class="flex-1">
          <span class="block opacity-60 mb-1">Top-P</span>
          <input type="number" id="pseries-top-p" min="0" max="1" step="0.01" placeholder="默认" class="input input-xs input-bordered w-full" value="${_apiCfg.top_p != null ? Number(_apiCfg.top_p) : ''}" />
        </label>
        <label class="flex-1">
          <span class="block opacity-60 mb-1">Top-K</span>
          <input type="number" id="pseries-top-k" min="0" max="500" step="1" placeholder="默认" class="input input-xs input-bordered w-full" value="${_apiCfg.top_k != null ? Number(_apiCfg.top_k) : ''}" />
        </label>
        <label class="flex-1">
          <span class="block opacity-60 mb-1">Min-P</span>
          <input type="number" id="pseries-min-p" min="0" max="1" step="0.01" placeholder="默认" class="input input-xs input-bordered w-full" value="${_apiCfg.min_p != null ? Number(_apiCfg.min_p) : ''}" />
        </label>
      </div>
    </div>
    <div class="divider text-[10px] opacity-40 my-2">提示词条目 (${prompts.length})</div>
    <div class="flex border border-base-300/40 rounded mb-2" style="min-height:220px;max-height:440px;">
      <div id="pseries-prompt-list" class="w-44 shrink-0 border-r border-base-300/40 overflow-y-auto"></div>
      <div id="pseries-prompt-editor" class="flex-1 overflow-y-auto p-2 min-w-0">
        <div class="text-center text-base-content/40 py-8">未选择条目。从左侧列表选择后在此处查看/编辑</div>
      </div>
    </div>
    <div class="flex gap-2">
      <button id="pseries-add-prompt" class="btn btn-xs btn-outline btn-success">＋ 添加条目</button>
      <button id="pseries-save" class="btn btn-xs btn-warning"><i data-ic="save"></i> 保存预设</button>
      <button id="pseries-run" class="btn btn-xs btn-outline btn-warning">▶️ 运行</button>
      <button id="pseries-refresh" class="btn btn-xs btn-ghost"><i data-ic="refresh"></i> 刷新</button>
      <button id="pseries-import" class="btn btn-xs btn-ghost" title="导入记忆预设 JSON（按文件内 id 覆盖对应 P 预设）">↓ 导入</button>
      <button id="pseries-export" class="btn btn-xs btn-ghost" title="导出当前预设为 JSON">↑ 导出</button>
    </div>
    <div id="pseries-output" class="mt-3 p-2 bg-base-200/50 rounded text-[10px] font-mono whitespace-pre-wrap hidden"></div>
  `;
  // use_custom 闸门联动：关=系统默认AI源（aiRunner 只在 use_custom=true 才转发 modelOverrides，
  // 下列字段是死值），UI 同步禁用+压暗，防止「填了数字以为生效」
  const _syncCustomFields = () => {
    const on = !!document.getElementById("pseries-use-custom")?.checked;
    const box = document.getElementById("pseries-custom-fields");
    if (!box) return;
    box.classList.toggle("opacity-40", !on);
    box.querySelectorAll("input,select").forEach((el) => { el.disabled = !on; });
  };
  document.getElementById("pseries-use-custom")?.addEventListener("change", _syncCustomFields);
  _syncCustomFields();
  // 数值控件值域从后端 param_schema 覆盖（缓存由 featureControls GetData 写入；
  // 无缓存=保留上方 HTML 静态 min/max/step 退化值，与 PARAM_SCHEMA 等值镜像）——同 subModePanel 约定
  applyParamSchemaToInputs([
    ["temperature", "pseries-temperature"],
    ["max_tokens", "pseries-max-tokens"],
    ["top_p", "pseries-top-p"],
    ["top_k", "pseries-top-k"],
    ["min_p", "pseries-min-p"],
  ]);
  // 模型下拉：从选中服务源拉可用模型（同 subModePanel _populateModelSelect：window._beiluGetModelList
  // 全局助手 + 竞态丢弃）；已绑定值不在列表也保留可选
  const _populatePseriesModels = async (srcName) => {
    const msel = document.getElementById("pseries-model");
    if (!msel) return;
    const current = _apiCfg.model || "";
    const reqId = ++_pseriesModelReqId;
    while (msel.options.length > 1) msel.remove(1);
    if (current) {
      const o = document.createElement("option");
      o.value = current; o.textContent = `${current}（已绑定）`;
      msel.appendChild(o); msel.value = current;
    }
    if (!srcName) return; // 默认源：不知道具体源无从拉模型列表，保留已绑定值
    let models = [];
    try {
      // [0717 撤 0716 E7 决定] 凛倾定案「拉条是每次都需要访问,不是访问一次就缓存」：
      //   打开/切源=点击驱动传 force 实时访问；失败仍回落收口内上次成功缓存（诚实降级）。
      models = window._beiluGetModelList ? await window._beiluGetModelList(srcName, { force: true }) : [];
    } catch (e) { console.warn("[memtool] 模型列表获取失败:", e?.message || e); }
    if (reqId !== _pseriesModelReqId) return;
    // [0716 E7 失败可见] 空列表给不可选提示项（对齐 subModePanel:2107 范式），用户可分辨「没请求」和「请求失败」
    if (!(models || []).length) {
      const warnOpt = document.createElement("option");
      warnOpt.disabled = true;
      warnOpt.textContent = "⚠ 未获取到模型列表（检查该 API 源的 URL/Key，详见运行时日志）";
      msel.appendChild(warnOpt);
      return;
    }
    (models || []).forEach((id) => {
      if (!id || id === current) return;
      const o = document.createElement("option");
      o.value = id; o.textContent = id;
      msel.appendChild(o);
    });
    if (current) msel.value = current;
  };
  // 服务源下拉：getAISources 单次缓存（与 subModePanel 同源同 verb）；存储值不在列表也保留可选
  (async () => {
    const sel = document.getElementById("pseries-source");
    if (!sel) return;
    if (!Array.isArray(_pseriesAISourceNames)) {
      try {
        const sources = await sendAction({ verb: "getAISources", target: "shells:serviceSourceManage", source: "web" });
        _pseriesAISourceNames = Array.isArray(sources) ? sources : Object.keys(sources || {});
      } catch (e) {
        console.warn("[memtool] AI源列表加载失败:", e?.message || e);
        window._reportError?.(`[memtool] AI源列表加载失败: ${e.message}`);
        _pseriesAISourceNames = null;
      }
    }
    const stored = _apiCfg.source || "";
    const names = Array.isArray(_pseriesAISourceNames) ? [..._pseriesAISourceNames] : [];
    if (stored && !names.includes(stored)) names.unshift(stored);
    sel.innerHTML = `<option value="">（默认源）</option>` +
      names.map((n) => `<option value="${_escapeHtml(n)}" ${n === stored ? 'selected' : ''}>${_escapeHtml(n)}</option>`).join("");
    sel.addEventListener("change", () => _populatePseriesModels(sel.value));
    _syncCustomFields();
    _populatePseriesModels(stored);
  })();

  // 工作副本：编辑暂存，「保存预设」整组写回；添加/删除即时持久化（同 memoryPresetChat 语义）
  _pseriesPrompts = prompts.map((pr) => ({ ...pr }));
  _pseriesPromptSel = null;
  // 内置条目（如 {{chat_history}} 历史对话宏，deletable:false）= 内容锁定：content 不可改、不可删，
  // 开关/身份/名称/排序放行（凛倾0711，ST marker 同款语义；后端 replacePresetPrompts 有同语义守卫兜底）
  const _isPromptContentLocked = (pr) => pr.builtin === true || pr.deletable === false;
  const _persistPrompts = async () => {
    await sendAction({ verb: "replacePresetPrompts", target: "plugins:beilu-memory", source: "web", payload: {
      presetId: name, promptSetKey: _setKey, prompts: _pseriesPrompts,
    } });
    if (_pseriesData[name]) _pseriesData[name][_setKey] = _pseriesPrompts.map((p) => ({ ...p }));
  };
  // 写串行链：拖拽/添加/删除都是「整组快照」写，乱序到达=旧快照覆盖新快照，promise 链保证先发先落
  let _persistChain = Promise.resolve();
  const _queuePersist = () => {
    const p = _persistChain.then(() => _persistPrompts());
    _persistChain = p.catch(() => {}); // 链自愈：单次失败由调用方上报，不永久阻断后续写
    return p;
  };
  let _dragIdx = null;
  const _renderPromptList = () => {
    const list = document.getElementById("pseries-prompt-list");
    if (!list) return;
    enableDragAutoScroll(list); // 0722：幂等注册（Set 按节点去重），拖拽排序边缘自动滚动
    list.innerHTML = _pseriesPrompts.map((pr, i) => {
      const pname = _escapeHtml(pr.name || pr.identifier || `prompt-${i}`);
      const enabled = pr.enabled !== false;
      const roleBadge = pr.role === 'user' ? 'U' : pr.role === 'assistant' ? 'A' : 'S';
      const roleColor = pr.role === 'user' ? 'badge-info' : pr.role === 'assistant' ? 'badge-success' : 'badge-ghost';
      return `<div class="flex items-center gap-1 px-2 py-1.5 text-[11px] cursor-pointer hover:bg-base-200/50 border-b border-base-300/30 ${i === _pseriesPromptSel ? 'bg-warning/15' : ''} ${enabled ? '' : 'opacity-40'}" data-pr-idx="${i}" draggable="true">
        <span class="cursor-grab opacity-30 hover:opacity-100" style="user-select:none">⠿</span>
        <span style="color:${enabled ? 'var(--beilu-success)' : 'var(--beilu-muted, #6b7280)'};">${enabled ? '✓' : '○'}</span>
        <span class="badge badge-xs ${roleColor}" title="身份: ${pr.role || 'system'}">${roleBadge}</span>
        <span class="flex-1 truncate" title="${pname}">${pname}</span>
        ${_isPromptContentLocked(pr) ? '<span class="badge badge-xs badge-ghost" title="内置条目：内容锁定，可开关/改身份/移动">内置</span>' : ''}
      </div>`;
    }).join("") || '<div class="opacity-40 text-center py-2 text-[11px]">无条目</div>';
    list.querySelectorAll("[data-pr-idx]").forEach((el) => {
      const idx = Number(el.dataset.prIdx);
      el.addEventListener("click", () => {
        _pseriesPromptSel = idx;
        _renderPromptList();
        _renderPromptEditor(_pseriesPromptSel);
      });
      // 拖拽排序：内置条目同样可移动（顺序=消息组装顺序），落盘走 replacePresetPrompts 整组快照
      el.addEventListener("dragstart", (ev) => { _dragIdx = idx; el.classList.add("opacity-30"); ev.dataTransfer.effectAllowed = "move"; });
      el.addEventListener("dragend", () => { _dragIdx = null; el.classList.remove("opacity-30"); list.querySelectorAll(".drag-over-top,.drag-over-bottom").forEach((n) => n.classList.remove("drag-over-top", "drag-over-bottom")); });
      el.addEventListener("dragover", (ev) => { ev.preventDefault(); if (_dragIdx === idx) return; const r = el.getBoundingClientRect(); const mid = r.top + r.height / 2; el.classList.toggle("drag-over-top", ev.clientY < mid); el.classList.toggle("drag-over-bottom", ev.clientY >= mid); });
      el.addEventListener("dragleave", () => el.classList.remove("drag-over-top", "drag-over-bottom"));
      el.addEventListener("drop", async (ev) => {
        ev.preventDefault();
        el.classList.remove("drag-over-top", "drag-over-bottom");
        if (_dragIdx == null || _dragIdx === idx) return;
        const fromIdx = _dragIdx;
        const selObj = _pseriesPromptSel != null ? _pseriesPrompts[_pseriesPromptSel] : null;
        const r = el.getBoundingClientRect();
        const insertBefore = ev.clientY < r.top + r.height / 2;
        const [moved] = _pseriesPrompts.splice(fromIdx, 1);
        const newIdx = insertBefore ? idx : idx + 1;
        _pseriesPrompts.splice(fromIdx < idx ? newIdx - 1 : newIdx, 0, moved);
        if (selObj) _pseriesPromptSel = _pseriesPrompts.indexOf(selObj);
        _renderPromptList();
        // 重渲编辑器：已打开的编辑器闭包持拖拽前索引，不刷新则删除按钮 splice 错位
        if (selObj) _renderPromptEditor(_pseriesPromptSel);
        try {
          await _queuePersist();
        } catch (e) {
          console.error("[memtool] 条目拖拽排序保存失败:", e);
          window._reportError?.(`[memtool] 条目拖拽排序保存失败: ${e.message}`);
        }
      });
    });
  };
  const _renderPromptEditor = (i) => {
    const host = document.getElementById("pseries-prompt-editor");
    const pr = _pseriesPrompts[i];
    if (!host || !pr) return;
    const locked = _isPromptContentLocked(pr);
    const pname = _escapeHtml(pr.name || pr.identifier || `prompt-${i}`);
    host.innerHTML = `<div class="space-y-2 text-xs">
      <div class="flex items-center justify-between">
        <span class="font-bold">${locked ? '<i data-ic="marker"></i> 内置条目（内容锁定）' : '<i data-ic="edit"></i> 条目编辑'}</span>
        ${locked ? '' : `<button id="pseries-p-del" class="btn btn-xs btn-error btn-ghost" title="删除条目"><i data-ic="trash"></i></button>`}
      </div>
      <div class="flex items-center gap-2">
        <label class="opacity-60 w-10 shrink-0">名称</label>
        <input type="text" id="pseries-p-name" class="input input-xs input-bordered flex-1" value="${pname}" />
      </div>
      <div class="flex items-center gap-2">
        <label class="opacity-60 w-10 shrink-0">启用</label>
        <input type="checkbox" id="pseries-p-enabled" class="toggle toggle-xs toggle-warning" ${pr.enabled !== false ? 'checked' : ''} />
      </div>
      <div class="flex items-center gap-2">
        <label class="opacity-60 w-10 shrink-0">角色</label>
        <select id="pseries-p-role" class="select select-xs select-bordered flex-1">
          <option value="system" ${!pr.role || pr.role === 'system' ? 'selected' : ''}>system</option>
          <option value="user" ${pr.role === 'user' ? 'selected' : ''}>user</option>
          <option value="assistant" ${pr.role === 'assistant' ? 'selected' : ''}>assistant</option>
        </select>
      </div>
      <div>
        <label class="opacity-60">内容</label>
        <div class="relative expandable-container mt-1">
          <textarea id="pseries-p-content" class="textarea textarea-bordered textarea-sm w-full text-[11px] font-mono" rows="10" data-expandable data-expand-title="${pname}" ${locked ? 'disabled' : ''}>${_escapeHtml(pr.content || pr.text || '')}</textarea>
          ${locked ? '' : '<button class="expand-btn" title="放大编辑"><i data-ic="fullscreen"></i></button>'}
        </div>
      </div>
      ${locked ? '<div class="text-[10px] opacity-50 italic">此条目的内容由系统在运行时生成（宏占位，如历史对话），无法在此处编辑，也不可删除；开关、身份、名称、排序可以修改。</div>' : ''}
    </div>`;
    host.querySelector("#pseries-p-name")?.addEventListener("input", (ev) => { pr.name = ev.target.value; });
    host.querySelector("#pseries-p-enabled")?.addEventListener("change", (ev) => { pr.enabled = ev.target.checked; _renderPromptList(); });
    host.querySelector("#pseries-p-role")?.addEventListener("change", (ev) => { pr.role = ev.target.value; _renderPromptList(); });
    if (locked) return;
    host.querySelector("#pseries-p-content")?.addEventListener("input", (ev) => { pr.content = ev.target.value; });
    host.querySelector("#pseries-p-del")?.addEventListener("click", async () => {
      if (!await beiluConfirm(`删除条目「${pr.name || pr.identifier || `prompt-${i}`}」？`)) return;
      try {
        _pseriesPrompts.splice(i, 1);
        await _queuePersist();
        _pseriesPromptSel = null;
        _renderPromptList();
        host.innerHTML = '<div class="text-center text-base-content/40 py-8">未选择条目。从左侧列表选择后在此处查看/编辑</div>';
      } catch (e) {
        console.error("[memtool] 删除提示词条目失败:", e);
        window._reportError?.(`[memtool] 删除提示词条目失败: ${e.message}`);
      }
    });
  };
  _renderPromptList();

  document.getElementById("pseries-add-prompt")?.addEventListener("click", async () => {
    const _suffix = _setKey === "prompts_code" ? "_code" : _setKey === "prompts_work" ? "_work" : "";
    const newPrompt = {
      role: "system", content: "", name: "新条目",
      identifier: `${name}${_suffix}_custom_${Date.now()}`,
      enabled: true, builtin: false, deletable: true,
    };
    // 与后端 addPresetPrompt 同语义：插在内置 {{chat_history}} 之前，保持历史对话在末尾
    const chIdx = _pseriesPrompts.findIndex((p) => p.builtin && p.content === "{{chat_history}}");
    if (chIdx >= 0) _pseriesPrompts.splice(chIdx, 0, newPrompt);
    else _pseriesPrompts.push(newPrompt);
    try {
      await _queuePersist();
      _pseriesPromptSel = chIdx >= 0 ? chIdx : _pseriesPrompts.length - 1;
      _renderPromptList();
      _renderPromptEditor(_pseriesPromptSel);
    } catch (e) {
      console.error("[memtool] 添加提示词条目失败:", e);
      window._reportError?.(`[memtool] 添加提示词条目失败: ${e.message}`);
    }
  });
  document.getElementById("pseries-save")?.addEventListener("click", () => _savePseries(name));
  document.getElementById("pseries-run")?.addEventListener("click", () => _runPseries(name));
  document.getElementById("pseries-refresh")?.addEventListener("click", _refreshPseriesList);
  // 导出：后端出完整可携带 JSON → Blob 下载（对齐 settings 预设 pp-export 范式）
  document.getElementById("pseries-export")?.addEventListener("click", async () => {
    const btn = document.getElementById("pseries-export");
    try {
      const r = await sendAction({ verb: "exportMemoryPreset", target: "plugins:beilu-memory", source: "web", payload: { presetId: name } });
      if (!r?.success || !r.json) throw new Error(r?.error || "无导出数据");
      const blob = new Blob([r.json], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${r.name || name}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      console.error("[memtool] 导出记忆预设失败:", e);
      window._reportError?.(`[memtool] 导出记忆预设失败: ${e.message}`);
      if (btn) { const prev = btn.textContent; btn.textContent = "❌ " + e.message; setTimeout(() => { btn.textContent = prev; }, 2500); }
    }
  });
  // 导入：文件选择 → type/id 校验在后端（P系列固定名单只覆盖不新增）→ 确认后覆盖 → 刷新重选
  document.getElementById("pseries-import")?.addEventListener("click", () => {
    const input = document.createElement("input");
    input.type = "file"; input.accept = ".json";
    input.addEventListener("change", async () => {
      const file = input.files[0];
      if (!file) return;
      const btn = document.getElementById("pseries-import");
      try {
        const parsed = JSON.parse(await file.text());
        const targetId = parsed?.preset?.id;
        if (!await beiluConfirm(`导入将覆盖预设「${targetId || "?"}」的提示词组/描述/AI参数（内置条目内容仍受锁保护），确定？`)) return;
        const r = await sendAction({ verb: "importMemoryPreset", target: "plugins:beilu-memory", source: "web", payload: { json: parsed } });
        if (r?.success === false) throw new Error(r.error || "导入失败");
        await _refreshPseriesList();
        _selectPseries(targetId);
        if (btn) { const prev = btn.textContent; btn.innerHTML = '<i data-ic="check"></i> 已导入'; setTimeout(() => { btn.textContent = prev; }, 1500); }
      } catch (e) {
        console.error("[memtool] 导入记忆预设失败:", e);
        window._reportError?.(`[memtool] 导入记忆预设失败: ${e.message}`);
        if (btn) { const prev = btn.textContent; btn.textContent = "❌ " + e.message; setTimeout(() => { btn.textContent = prev; }, 2500); }
      }
    });
    input.click();
  });
  // 查看模式切换：只换看哪套提示词组，不动会话 live 态
  detail.querySelectorAll("#pseries-viewmode [data-vm]").forEach((b) => {
    b.addEventListener("click", () => { _pseriesViewMode = b.dataset.vm; _selectPseries(name); });
  });
}

async function _savePseries(id) {
  if (!id) return;
  const btn = document.getElementById("pseries-save");
  if (!btn) return;
  const prev = btn.textContent; btn.textContent = "保存中..."; btn.disabled = true;
  // 条目编辑直接写工作副本（_renderPromptEditor 的 input/change 监听），这里整组带完整字段
  // （identifier/builtin/deletable/role）写回，内置条目身份不丢。
  const promptItems = _pseriesPrompts.map((p) => ({ ...p, role: p.role || "system" }));
  try {
    // 注意: 后端 updateMemoryPreset 不处理 model/temperature,塞到 api_config 里透传。
    // 原 POST setdata {_action:updateMemoryPreset,...} → memory 通配路由 verb=真动作组装 _action
    await sendAction({ verb: "updateMemoryPreset", target: "plugins:beilu-memory", source: "web", payload: {
      presetId: id,
      enabled: document.getElementById("pseries-enabled")?.checked,
      description: document.getElementById("pseries-description")?.value || "",
      // 数值空=不带键（updateMemoryPreset 是 merge，保留旧值）；枚举/开关始终显式写
      api_config: Object.fromEntries(Object.entries({
        use_custom: !!document.getElementById("pseries-use-custom")?.checked,
        source: document.getElementById("pseries-source")?.value || "",
        model: document.getElementById("pseries-model")?.value || "",
        temperature: isNaN(parseFloat(document.getElementById("pseries-temperature")?.value)) ? undefined : parseFloat(document.getElementById("pseries-temperature")?.value),
        max_tokens: (() => { const v = parseInt(document.getElementById("pseries-max-tokens")?.value, 10); return Number.isFinite(v) && v > 0 ? v : undefined; })(),
        top_p: isNaN(parseFloat(document.getElementById("pseries-top-p")?.value)) ? undefined : parseFloat(document.getElementById("pseries-top-p")?.value),
        top_k: (() => { const v = parseInt(document.getElementById("pseries-top-k")?.value, 10); return Number.isFinite(v) ? v : undefined; })(),
        min_p: isNaN(parseFloat(document.getElementById("pseries-min-p")?.value)) ? undefined : parseFloat(document.getElementById("pseries-min-p")?.value),
        // prefill_enabled 不写：全链无消费者的历史死键（真机制=claude_prefill_mode 四模式），不做死开关
        prompt_post_processing: document.getElementById("pseries-pp")?.value || "strict",
        claude_prefill_mode: document.getElementById("pseries-prefill-mode")?.value || "off",
      }).filter(([, v]) => v !== undefined)),
    } });
    // ★ 按查看模式存回对应提示词组（修：原来恒写 chat 的 prompts，code/work 改了存不进）。原 POST setdata {_action:replacePresetPrompts,...} → memory 通配路由
    await sendAction({ verb: "replacePresetPrompts", target: "plugins:beilu-memory", source: "web", payload: {
      presetId: id, promptSetKey: _PSERIES_SETKEY[_pseriesViewMode] || "prompts", prompts: promptItems,
    } });
    btn.innerHTML = '<i data-ic="check"></i> 已保存';
    await _refreshPseriesList();
  } catch (e) {
    console.error("[layout] savePseries error:", e);
    window._reportError?.(`[layout] savePseries error: ${e.message}`);
    btn.textContent = "❌ " + e.message;
  }
  setTimeout(() => { btn.textContent = prev; btn.disabled = false; }, 1500);
}

async function _runPseries(id) {
  const out = document.getElementById("pseries-output");
  const btn = document.getElementById("pseries-run");
  if (!out || !btn) return;
  out.classList.remove("hidden");
  out.textContent = "运行中...";
  const prev = btn.textContent; btn.textContent = "..."; btn.disabled = true;
  try {
    // 原 POST setdata {_action:runMemoryPreset,...} → memory 通配路由
    const j = await sendAction({ verb: "runMemoryPreset", target: "plugins:beilu-memory", source: "web", payload: { presetId: id } });
    out.textContent = j.success ? ("✅ 运行完成\n\n" + (j.output || JSON.stringify(j, null, 2))) : ("❌ 运行失败: " + (j.error || JSON.stringify(j)));
  } catch (e) {
    console.error("[layout] runPseries error:", e);
    window._reportError?.(`[layout] runPseries error: ${e.message}`);
    out.textContent = "❌ " + e.message;
  }
  btn.textContent = prev; btn.disabled = false;
}

const _escapeHtml = escapeHtml;

export { initMemToolbar, _toggleMemMainArea, _showMemContentSub, _showDiagretrSub, _showOpsSub };

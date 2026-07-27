/**
 * @file injectDock.mjs — 注入坞（对话框旁的 INJ 条目运行时操作台）
 *
 * 【功能链】
 *   工具栏 💬✨ 按钮 → openInjectDock() → 懒建浮窗 DOM（body 级 fixed，对齐按钮上方）
 *   → refresh(): sendAction{verb:"getData",target:"plugins:beilu-memory"} 拉后端真值
 *      （injection_prompts 条目 + injection_effective 逐条生效裁决 + injection_automode_meta 值域）
 *   → renderList(): 搜索/排序切片后渲染，每条两个注入动作：
 *      ⚡ 这轮  → 加入本轮队列 _onceIds（纯前端会话态，不写盘）
 *      📌 常驻  → updateInjectionPrompt{enabled} （长期注入，每轮按 autoMode 门控自动注入）
 *   → sendMessage 发送时 getOnceInjectIds() → POST /message{single_inject_ids}
 *      → triggerCharReply{onceInjectIds} → requestBuilder extension.once_inject_ids
 *      → injectionSystem.resolveInjectionContext ctx.onceIds → resolveEffectiveInjections
 *      → getPromptHandler INJ 循环照常注入 → 发送成功后 clearOnceInjectQueue() 清队列
 *
 * 【why 条目引用而非文本副本】
 *   旧「单次注入层」= 一个 textarea 的 DOM 值（index.html #single-inject / panels.mjs 镜像），
 *   全局只有一份：写进去下一条必带、无法选择注入哪条、无法存第二条、发完即清无法留存
 *   （凛倾 0726「完全没有办法使用…如果我想写其他东西,也不行…这个完全就是 bug」）。
 *   本模块改为「条目库 + 引用注入」：条目复用既有 INJ 存储（injection_prompts，零新存储——
 *   0723 凛倾已判「说明书库和 inj 重复」整域删除，再起一套条目库是同一个错），单次注入只传
 *   条目 id，由 INJ 正线注入 → 条目的 role/depth/order/宏 全部照常生效，且注入的永远是条目
 *   当前内容。传原文副本的形态（chip 条把 skill 原文写进单次注入框）已被 0617/0706 两次否决
 *   （skillInjectBar 整删，index.mjs:40）——副本会把改条目前的旧原文注进去，且丢失位置与角色。
 *
 * 【why 单次绕过门控】
 *   单次=用户对这一条按下的显式动作，优先于全部自动门控（enabled/模式域/INJ-2 互斥/平台限定）。
 *   自动规则的职责是替用户处理「没表态」的条目，用户点了名就不该被自动规则否决
 *   （判定本体在 injectionSystem.resolveEffectiveInjections，前端只传 id 不做裁决）。
 *
 * 【关联链】
 *   上游：index.mjs initInjectDock() 挂载 · panels.mjs「打开注入坞」按钮 → openInjectDock()
 *   下游：messageInput.mjs sendMessage → getOnceInjectIds() / clearOnceInjectQueue()
 *   后端：beilu-memory getData（读）· addInjectionPrompt/updateInjectionPrompt/deleteInjectionPrompt（写）
 *   刷新事件：beilu:injectionPromptsChanged（后端 CRUD 广播）/ beilu:mode-switched /
 *            beilu:ide-connected / beilu:ide-disconnected —— 生效徽标随模式与 IDE 连接变化
 *   CSS：css/ui-modules.css 的 .inject-dock / .idock-* 段（浮窗范式照抄 .extend-menu-popup：
 *        fixed + var(--beilu-bg-card) + var(--beilu-amber-20) + var(--z-popup)；行内控件用
 *        daisyUI 类 btn/input/select/checkbox/badge，不自造第二套控件样式）
 *
 * 【影响范围】
 *   - DOM：body 下懒建 #inject-dock 一个节点；内含 #single-inject（旧「临时一句话」通道的
 *     承载元素迁到此处，id 不变 → messageInput.mjs 读点零改动继续有效）
 *   - 后端写：仅 INJ 条目 CRUD（与设置面板 INJ 编辑器同一批 action，无独立存储）
 *   - localStorage：BEILU_INJECT_DOCK_SORT（排序偏好）/ BEILU_INJECT_DOCK_RECENT（最近使用排序用）
 *   - 单次队列 _onceIds 是纯内存会话态：刷新页面即空，任何路径都不写盘
 *
 * 【使用效果】
 *   点工具栏按钮弹出注入坞 → 搜索/排序找到条目 → 点 ⚡ 挂到本轮（按钮上出现待注入计数，
 *   发一条消息后自动清空）或点 📌 常驻（长期注入，不随发送清除）→ 点 ✎ 就地改名称/内容/
 *   位置(上方·下方 + 排序值)/角色/注入模式 → 点「＋ 新建」现场加一条条目。
 */

import { escapeHtml } from "../state/utils.mjs";
import { sendAction } from "../transport/sendAction.mjs";
import { storage, KEYS } from "../state/storage.mjs";
import { beiluConfirm } from "../widgets/beiluDialog.mjs";

// ============================================================
// 模块态
// ============================================================

/** 本轮单次注入队列（条目 id）——纯内存，不写盘：语义=「这一条消息带上它们」，发完即散 */
const _onceIds = new Set();

let _dock = null;          // 浮窗根节点（懒建）
let _entries = [];         // 后端 injection_prompts 真值
let _effectiveById = {};   // 后端 injection_effective 逐条裁决（前端不重算，只渲染）
let _meta = { modes: [], aliases: [], special: [], options: [] }; // autoMode 值域（后端权威清单）
let _activeMode = "chat";
let _search = "";
let _sort = "order";
let _editingId = null;     // 就地编辑展开中的条目 id
let _filterMode = "__all"; // 分类（模式窗口）过滤：__all=全部 / __special=全局域 / 具体 autoMode
let _loading = false;

/** 后端未下发 meta 时的最小兜底集（离线可用即可，联机后立刻被后端权威清单覆盖） */
const FALLBACK_AUTOMODES = ["always", "manual"];

/** 模式显示名（纯渲染糖：选项集合本身来自后端 meta，无映射的新模式回退原 id） */
const MODE_LABEL = {
  chat: "聊天", airp: "AIRP", code: "代码", work: "工作", smart: "全智能", bot: "Bot",
  always: "全模式", all: "全模式", manual: "手动开启", file: "文件活动",
};
const _modeLabel = (m) => MODE_LABEL[m] || m || "always";

/** 生效裁决 reason → 人话（与 panels.mjs INJ 面板同一份文案语义） */
const REASON_NOTE = {
  disabled: "未开启",
  scope_mismatch: "当前模式不匹配",
  platform_mismatch: "平台不匹配",
  unknown_automode: "未知注入模式",
  variant_ide_off: "需 YonBan 连接",
  variant_manual_base: "基础版手动开启",
  base_overridden: "被 -code 变体覆盖",
};

const _toast = (msg, type) => window._beiluToast?.(msg, type);

// ============================================================
// 后端读写（全部走 sendAction 出向门面，与 INJ 面板同一批 action）
// ============================================================

const _postSet = (action, payload) =>
  sendAction({ verb: action, target: "plugins:beilu-memory", source: "web", payload: payload || {} });

async function _fetchEntries() {
  const d = (await sendAction({ verb: "getData", target: "plugins:beilu-memory", source: "web" })) || {};
  _entries = Array.isArray(d.injection_prompts) ? d.injection_prompts : [];
  _activeMode = d.activeMode || "chat";
  const meta = d.injection_automode_meta || {};
  _meta = {
    modes: Array.isArray(meta.modes) ? meta.modes : [],
    aliases: Array.isArray(meta.aliases) ? meta.aliases : [],
    special: Array.isArray(meta.special) ? meta.special : [],
    options: Array.isArray(meta.options) && meta.options.length ? meta.options : FALLBACK_AUTOMODES,
  };
  _effectiveById = {};
  for (const g of Array.isArray(d.injection_effective) ? d.injection_effective : []) {
    _effectiveById[g.id] = { on: !!g.on, note: g.reason ? REASON_NOTE[g.reason] || g.reason : "" };
  }
}

// ============================================================
// 最近使用（排序用；纯本地偏好，丢了不影响功能）
// ============================================================

function _readRecent() {
  try {
    const v = JSON.parse(storage.get(KEYS.BEILU_INJECT_DOCK_RECENT) || "[]");
    return Array.isArray(v) ? v.filter((s) => typeof s === "string") : [];
  } catch { return []; }
}
function _markRecent(id) {
  const list = _readRecent().filter((x) => x !== id);
  list.unshift(id);
  storage.set(KEYS.BEILU_INJECT_DOCK_RECENT, JSON.stringify(list.slice(0, 50)));
}

// ============================================================
// 列表切片：搜索 + 排序（纯前端展示，不改存储字段、不动门控）
// ============================================================

const SORTS = [
  ["order", "注入顺序"],
  ["name", "名称"],
  ["recent", "最近使用"],
  ["active", "生效优先"],
];

function _visibleEntries() {
  const q = _search.trim().toLowerCase();
  const recent = _sort === "recent" ? _readRecent() : null;
  const list = _entries.filter((e) => {
    if (!_isUserSkill(e)) return false; // 内置 INJ 不进注入坞（归设置面板长期 inj）
    if (!_passModeFilter(e)) return false;
    if (!q) return true;
    return (
      String(e.id || "").toLowerCase().includes(q) ||
      String(e.name || "").toLowerCase().includes(q) ||
      String(e.description || "").toLowerCase().includes(q) ||
      String(e.content || "").toLowerCase().includes(q)
    );
  });
  const nameOf = (e) => String(e.name || e.description || e.id || "");
  const cmp = {
    order: (a, b) => (a.order ?? 0) - (b.order ?? 0) || nameOf(a).localeCompare(nameOf(b), "zh"),
    name: (a, b) => nameOf(a).localeCompare(nameOf(b), "zh"),
    recent: (a, b) => {
      const ia = recent.indexOf(a.id), ib = recent.indexOf(b.id);
      return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib) || nameOf(a).localeCompare(nameOf(b), "zh");
    },
    active: (a, b) => {
      const oa = _effectiveById[a.id]?.on ? 0 : 1, ob = _effectiveById[b.id]?.on ? 0 : 1;
      return oa - ob || (a.order ?? 0) - (b.order ?? 0);
    },
  }[_sort] || ((a, b) => (a.order ?? 0) - (b.order ?? 0));
  return list.sort(cmp);
}

/**
 * 注入坞的条目域 = **用户自建条目（skill）**，内置条目不进这里。
 *
 * 凛倾 0726 定案：「现在的 skill 完全没有系统设定，系统的话只有长期 inj 有」——
 * 注入坞是 skill 的挑选台，系统 INJ 归设置面板的长期 inj 编辑器管。
 * 实测出厂模板 42 条 injection_prompts 里 41 条 builtin=true（INJ-1~5 / triage / 各 data 模板），
 * 用户自建的一条都没有（只有点「＋新建」才产生，后端 addInjectionPrompt 写 builtin:false）——
 * 把内置层搬进来等于把长期 inj 整套塞进 skill 台，正是这次要修掉的形态。
 *
 * 判据 = 后端 addInjectionPrompt 的 `builtin:false` 契约取反。
 * ⚠ 已知模板数据瑕疵：INJ-browser（浏览器自动化能力说明）标了 builtin:false + deletable:true，
 *   明显是内置条目却会被此判据放行。属模板字段标注不一致，该在数据侧修（且要连用户副本一起，
 *   改 defaults 不同步副本=零生效），不由前端判据兜——已单列报告，未擅自改。
 */
const _isUserSkill = (e) => e.builtin !== true;

// ── 分类（模式窗口）过滤 ───────────────────────────────────────
// 「分类」= 条目的 autoMode，即凛倾定的「新建先分类分窗口」那个窗口。判据与选项集合全部与
// 设置面板 INJ 编辑器同源，且集合本身来自后端 injection_automode_meta（禁硬编码清单——
// 前端曾各持一份 AUTO_MODES 死值，缺 smart、留 airp 假值，inj 识别系统 0713 已收口到后端单源）。

/** file 是 code 的系统原生子系列（凛倾 0723「file就是code系列，选file归类到code」） */
const _MODE_SUBSERIES = { code: ["code", "file"] };

const _passModeFilter = (e) =>
  _filterMode === "__all" ? true
  : _filterMode === "__special"
    ? _meta.special.includes(e.autoMode) && !_MODE_SUBSERIES.code.includes(e.autoMode)
    : (_MODE_SUBSERIES[_filterMode] || [_filterMode]).includes(e.autoMode);

function _renderModes() {
  const bar = _dock?.querySelector("#idock-modes");
  if (!bar) return;
  const chips = [
    ["__all", "全部"],
    // [0726 凛倾令] 与设置面板 INJ 同步删「全智能 smart」chip：smart 域 ⊇ chat 域，两 chip 出同一批条目=冲突。
    ...[...new Set([..._meta.modes, ..._meta.aliases])].filter((m) => m !== "smart").map((m) => [m, _modeLabel(m)]),
    ["__special", "全局∗"],
  ];
  bar.innerHTML = chips
    .map(([v, label]) =>
      `<button data-mode="${escapeHtml(v)}" class="idock-chip${_filterMode === v ? " active" : ""}"${
        v === "__special" ? ' title="always/all=全模式 ｜ manual=手动开启 ｜ file=文件活动门控 — 各有门控条件，非无条件全局"' : ""
      }>${escapeHtml(label)}</button>`)
    .join("");
}

// ============================================================
// 渲染
// ============================================================

/** 位置语义与 INJ 编辑器向导第二步同源：depth 0=聊天记录之后(尾部)，≥1=聊天记录之前 */
const _posLabel = (e) => ((e.depth ?? 0) >= 1 ? "上方" : "下方");

function _rowHtml(e) {
  const id = String(e.id || "");
  const name = String(e.name || e.description || id);
  const ef = _effectiveById[id] || { on: false, note: "" };
  const queued = _onceIds.has(id);
  const keep = e.enabled !== false;
  const effHtml = keep
    ? ef.on
      ? '<span class="idock-eff on">✓ 生效中</span>'
      : `<span class="idock-eff off" title="${escapeHtml(ef.note || "当前模式不匹配")}">⊘ ${escapeHtml(ef.note || "不匹配")}</span>`
    : '<span class="idock-eff idle">未常驻</span>';
  return `
    <div class="idock-row${queued ? " queued" : ""}${_editingId === id ? " editing" : ""}" data-id="${escapeHtml(id)}">
      <div class="idock-row-main">
        <input type="checkbox" class="checkbox checkbox-xs checkbox-success idock-keep" ${keep ? "checked" : ""}
          title="长期注入：开启后每轮按注入模式自动注入，不随发送清除" />
        <span class="idock-name" title="${escapeHtml(name)}&#10;${escapeHtml(id)}">${escapeHtml(name)}</span>
        <button class="idock-btn idock-once${queued ? " active" : ""}"
          title="${queued ? "取消本轮注入" : "只注入这一轮：随下一条消息带上，发完即清，不改条目开关"}">⚡</button>
        <button class="idock-btn idock-edit" title="编辑内容与位置">✎</button>
      </div>
      <div class="idock-row-sub">
        <span class="badge badge-xs badge-ghost">${escapeHtml(_modeLabel(e.autoMode || "always"))}</span>
        <span class="idock-pos" title="注入位置：${_posLabel(e)}（排序值 ${e.order ?? 0}，越小越靠前）">${_posLabel(e)}·${e.order ?? 0}</span>
        ${effHtml}
        ${queued ? '<span class="idock-queued-tag">本轮 ⚡</span>' : ""}
      </div>
    </div>`;
}

function _editorHtml(e) {
  const opts = _meta.options.length ? _meta.options : FALLBACK_AUTOMODES;
  const cur = e.autoMode || "always";
  return `
    <div class="idock-editor" data-id="${escapeHtml(String(e.id))}">
      <input class="input input-xs input-bordered w-full idock-f-name" value="${escapeHtml(e.name || "")}" placeholder="条目名称" />
      <textarea class="textarea textarea-bordered textarea-xs w-full idock-f-content" rows="5"
        placeholder="提示词正文">${escapeHtml(e.content || "")}</textarea>
      <div class="idock-editor-grid">
        <label>注入模式</label>
        <select class="select select-xs select-bordered idock-f-automode">
          ${opts.map((m) => `<option value="${escapeHtml(m)}"${m === cur ? " selected" : ""}>${escapeHtml(_modeLabel(m))}</option>`).join("")}
        </select>
        <label>位置</label>
        <select class="select select-xs select-bordered idock-f-depth">
          <option value="0"${(e.depth ?? 0) >= 1 ? "" : " selected"}>下方（聊天记录之后·尾部）</option>
          <option value="1"${(e.depth ?? 0) >= 1 ? " selected" : ""}>上方（聊天记录之前）</option>
        </select>
        <label>排序</label>
        <input type="number" class="input input-xs input-bordered idock-f-order" value="${Number(e.order ?? 0)}" title="值越小越靠前（可负）" />
        <label>角色</label>
        <select class="select select-xs select-bordered idock-f-role">
          ${["system", "user", "assistant"].map((r) => `<option${(e.role || "system") === r ? " selected" : ""}>${r}</option>`).join("")}
        </select>
      </div>
      <div class="idock-editor-actions">
        <button class="btn btn-xs btn-primary idock-f-save">💾 保存</button>
        <button class="btn btn-xs btn-ghost idock-f-cancel">取消</button>
        <button class="btn btn-xs btn-ghost text-error idock-f-del">🗑 删除</button>
      </div>
    </div>`;
}

/**
 * 渲染：条目全是 skill（同一类，不分层）。唯一的分段是「⚡ 本轮待注入」置顶——
 * 让已挑的条目不随分类切换/搜索跑出视野，随时看得见这条消息会带什么、随时能取消。
 */
function _renderList() {
  const list = _dock?.querySelector("#idock-list");
  if (!list) return;
  if (_loading) { list.innerHTML = '<p class="idock-empty">加载中…</p>'; return; }
  const rows = _visibleEntries();
  const withEditor = (e) => _rowHtml(e) + (_editingId === String(e.id) ? _editorHtml(e) : "");
  const queued = rows.filter((e) => _onceIds.has(String(e.id)));
  const rest = rows.filter((e) => !_onceIds.has(String(e.id)));

  if (!rows.length) {
    list.innerHTML =
      _search ? '<p class="idock-empty">没有匹配的 skill</p>'
      : _filterMode !== "__all" ? '<p class="idock-empty">这个分类下还没有 skill——点右上「＋ 新建」建在这里</p>'
      : '<p class="idock-empty">还没有 skill——点右上「＋ 新建」加一条</p>';
    return;
  }

  let html = "";
  if (queued.length) {
    html += `<div class="idock-group">⚡ 本轮待注入 <span class="idock-group-n">${queued.length}</span></div>`;
    html += queued.map(withEditor).join("");
    if (rest.length) html += '<div class="idock-group">📚 全部 skill</div>';
  }
  html += rest.map(withEditor).join("");
  list.innerHTML = html;
}

/** 队列计数同步到工具栏按钮（用户收起浮窗后仍看得见本轮挂了几条，防"不知道带了什么就发出去"） */
function _syncBadge() {
  const btn = document.getElementById("single-inject-btn");
  if (!btn) return;
  const n = _onceIds.size;
  btn.classList.toggle("has-once", n > 0);
  btn.dataset.onceCount = n > 0 ? String(n) : "";
  const qb = _dock?.querySelector("#idock-queue");
  if (qb) {
    qb.textContent = n > 0 ? `本轮 ${n} 条` : "";
    qb.classList.toggle("hidden", n === 0);
  }
}

// ============================================================
// 浮窗骨架 + 事件（容器级委托：列表每次重渲染，逐行绑定会漏/会叠）
// ============================================================

function _buildDock() {
  const el = document.createElement("div");
  el.id = "inject-dock";
  el.className = "inject-dock hidden";
  el.innerHTML = `
    <div class="idock-header">
      <span class="idock-title">💉 注入坞</span>
      <span id="idock-queue" class="idock-queue hidden"></span>
      <button id="idock-close" class="idock-close" title="收起">✕</button>
    </div>
    <div class="idock-tools">
      <input id="idock-search" class="input input-xs input-bordered idock-search" placeholder="搜索条目…" />
      <select id="idock-sort" class="select select-xs select-bordered idock-sort" title="排序方式">
        ${SORTS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}
      </select>
      <button id="idock-new" class="btn btn-xs btn-ghost text-success" title="新建一条注入条目（建在当前选中的分类下）">＋ 新建</button>
    </div>
    <div id="idock-modes" class="idock-modes"></div>
    <div id="idock-list" class="idock-list"></div>
    <div class="idock-footer">
      <label class="idock-footer-label" title="不存条目、只对下一条消息生效的一句话；发送后自动清空">
        临时一句话 <span class="idock-footer-hint">不存条目·发送即清</span>
      </label>
      <div class="relative expandable-container">
        <textarea id="single-inject" class="textarea textarea-bordered textarea-xs w-full idock-temp"
          rows="2" placeholder="这次想临时说一句（不会存成条目）…"
          data-expandable data-expand-title="临时注入"></textarea>
        <button class="expand-btn" data-expand-target="single-inject" title="放大编辑">⛶</button>
      </div>
    </div>`;
  // 放大编辑：expandEditor 需要 .expandable-container 包裹 + 同级 .expand-btn（三者缺一即哑火），
  // 浮窗是懒建的但该模块挂了 MutationObserver（expandEditor.mjs:67）会自动绑新按钮，无需在此手绑。
  document.body.appendChild(el);

  el.querySelector("#idock-close").addEventListener("click", () => closeInjectDock());
  el.querySelector("#idock-search").addEventListener("input", (ev) => { _search = ev.target.value; _renderList(); });
  const sortEl = el.querySelector("#idock-sort");
  sortEl.value = _sort;
  sortEl.addEventListener("change", (ev) => {
    _sort = ev.target.value;
    storage.set(KEYS.BEILU_INJECT_DOCK_SORT, _sort);
    _renderList();
  });
  el.querySelector("#idock-new").addEventListener("click", _onCreate);
  el.querySelector("#idock-list").addEventListener("click", _onListClick);
  // 分类 chips（委托：选项随 meta 每次 load 重渲染）
  el.querySelector("#idock-modes").addEventListener("click", (ev) => {
    const btn = ev.target instanceof Element ? ev.target.closest(".idock-chip") : null;
    if (!btn) return;
    _filterMode = btn.dataset.mode;
    _renderModes();
    _renderList();
  });
  // 浮窗内点击不冒泡到 document：否则「点外关闭」会把自己关掉
  el.addEventListener("click", (ev) => ev.stopPropagation());
  return el;
}

async function _onCreate() {
  // 分类 = 当前选中的 chip（凛倾「新建先分类分窗口」：在哪个分类下点新建就建在哪个分类，
  //   建完在行内编辑器里还能改）。选「全部」/「全局∗」时落 manual——「开即生效、不受模式域门控」，
  //   正是手动挑的 skill 该有的语义。位置默认下方尾部、排序追加末尾，与 INJ 新建向导默认一致。
  const _autoMode = _filterMode === "__all" || _filterMode === "__special" ? "manual" : _filterMode;
  const maxOrder = _entries.reduce((m, p) => Math.max(m, p.order || 0), 0);
  try {
    const j = await _postSet("addInjectionPrompt", {
      name: "新 skill", description: "", content: "",
      autoMode: _autoMode, role: "system", depth: 0, order: maxOrder + 100, enabled: false,
    });
    if (!j?.success) { _toast("新建失败: " + (j?.error || "未知"), "error"); return; }
    await refreshInjectDock();
    _editingId = String(j.id || "");
    _renderList();
    // 新建即展开编辑并聚焦名称：条目是空的，不展开等于建了个看不见的东西
    _dock?.querySelector(".idock-editor .idock-f-name")?.focus();
    _dock?.querySelector(`.idock-row[data-id="${CSS.escape(_editingId)}"]`)?.scrollIntoView({ block: "nearest" });
  } catch (err) { _toast("新建失败: " + err.message, "error"); }
}

async function _onListClick(ev) {
  const target = ev.target;
  if (!(target instanceof Element)) return;

  // —— 编辑器内的动作（保存/取消/删除）——
  const editor = target.closest(".idock-editor");
  if (editor) {
    const id = editor.dataset.id;
    if (target.closest(".idock-f-cancel")) { _editingId = null; _renderList(); return; }
    if (target.closest(".idock-f-save")) {
      const body = {
        injectionId: id,
        name: editor.querySelector(".idock-f-name").value,
        content: editor.querySelector(".idock-f-content").value,
        autoMode: editor.querySelector(".idock-f-automode").value,
        depth: parseInt(editor.querySelector(".idock-f-depth").value, 10) || 0,
        order: parseInt(editor.querySelector(".idock-f-order").value, 10) || 0,
        role: editor.querySelector(".idock-f-role").value,
      };
      try {
        const j = await _postSet("updateInjectionPrompt", body);
        if (!j?.success) { _toast("保存失败: " + (j?.error || "未知"), "error"); return; }
        _editingId = null;
        await refreshInjectDock();
        _toast("已保存", "success");
      } catch (err) { _toast("保存失败: " + err.message, "error"); }
      return;
    }
    if (target.closest(".idock-f-del")) {
      const e = _entries.find((x) => String(x.id) === id);
      const label = e?.name || id;
      // 删除即永久（后端 loadMemoryPresets 不会补回，找回途径只有 INJ 面板「恢复默认」且仅限内置项）
      if (!(await beiluConfirm(`删除条目「${label}」？删除后不可撤销。`))) return;
      try {
        await _postSet("deleteInjectionPrompt", { injectionId: id });
        _onceIds.delete(id);           // 队列里若挂着它，一并摘掉，避免发送时引用已删条目
        _editingId = null;
        await refreshInjectDock();
        _syncBadge();
      } catch (err) { _toast("删除失败: " + err.message, "error"); }
      return;
    }
    return; // 编辑器内其他点击（输入框等）不触发行为
  }

  // —— 行上的动作 ——
  const row = target.closest(".idock-row");
  if (!row) return;
  const id = row.dataset.id;

  if (target.closest(".idock-once")) {
    if (_onceIds.has(id)) _onceIds.delete(id);
    else { _onceIds.add(id); _markRecent(id); }
    _syncBadge();
    _renderList();
    return;
  }
  if (target.closest(".idock-edit") || target.closest(".idock-name")) {
    _editingId = _editingId === id ? null : id;
    _renderList();
    return;
  }
  if (target.closest(".idock-keep")) {
    const cb = target.closest(".idock-keep");
    const want = cb.checked;
    try {
      const j = await _postSet("updateInjectionPrompt", { injectionId: id, enabled: want });
      if (!j?.success) { cb.checked = !want; _toast("保存失败: " + (j?.error || "未知"), "error"); return; }
      if (want) _markRecent(id);
      await refreshInjectDock();   // 生效徽标是后端裁决，开关后必须重拉，不本地臆测
    } catch (err) { cb.checked = !want; _toast("保存失败: " + err.message, "error"); }
  }
}

/** 定位：贴在触发按钮正上方，超出视口时向内收（窄屏由 CSS 接管全宽，见 ui-modules.css @media） */
function _positionDock() {
  const btn = document.getElementById("single-inject-btn");
  if (!_dock || !btn) return;
  const r = btn.getBoundingClientRect();
  _dock.style.left = "";
  _dock.style.bottom = "";
  const w = _dock.offsetWidth || 340;
  const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
  _dock.style.left = `${left}px`;
  _dock.style.bottom = `${Math.max(8, window.innerHeight - r.top + 8)}px`;
}

// ============================================================
// 对外 API
// ============================================================

/** 拉后端真值并重渲染（对外：条目变更事件、开关后回读都走这里，前端不臆测生效状态） */
export async function refreshInjectDock() {
  if (!_dock) return;
  _loading = !_entries.length; // 首次拉取才显示「加载中」，后续静默替换避免闪烁
  _renderList();
  try {
    await _fetchEntries();
  } catch (err) {
    _loading = false;
    const list = _dock.querySelector("#idock-list");
    if (list) list.innerHTML = `<p class="idock-empty">加载失败：${escapeHtml(err.message)}</p>`;
    return;
  }
  _loading = false;
  // 队列里引用的条目可能已被别处删除（多窗口/设置面板）——静默摘除，防发送时引用幽灵 id
  for (const id of [..._onceIds]) if (!_entries.some((e) => String(e.id) === id)) _onceIds.delete(id);
  _syncBadge();
  _renderModes(); // chips 选项来自后端 meta，随每次 load 重渲染（模式集可因注册变化）
  _renderList();
}

export function openInjectDock() {
  if (!_dock) _dock = _buildDock();
  _dock.classList.remove("hidden");
  _positionDock();
  refreshInjectDock();
  _dock.querySelector("#idock-search")?.focus();
}

export function closeInjectDock() {
  _dock?.classList.add("hidden");
}

export function toggleInjectDock() {
  if (!_dock || _dock.classList.contains("hidden")) openInjectDock();
  else closeInjectDock();
}

/**
 * 本轮单次注入的条目 id 列表 —— sendMessage 发送前读。
 * @returns {string[]} 条目 id（顺序无意义：真实注入序由各条目自己的 depth/order 决定）
 */
export function getOnceInjectIds() {
  return [..._onceIds];
}

/**
 * 清掉「已随这条消息送出去」的那批条目（发送成功后调；失败不清，用户可原样重发）。
 *
 * why 按 id 清而不是 clear()：`await addUserReply` 期间浮窗仍可操作，用户完全可能已经在
 * 给下一条消息挑条目了——无条件 clear 会把这些新挑的一起吃掉（网络越慢越容易踩）。
 * 单次语义是「这一条消息带走它自己那批」，清的对象就该是那批。
 *
 * @param {string[]} [ids] 本次已消费的条目 id；省略=清空全部（兼容无参调用）
 */
export function clearOnceInjectQueue(ids) {
  const consumed = Array.isArray(ids) ? ids : [..._onceIds];
  let changed = false;
  for (const id of consumed) if (_onceIds.delete(id)) changed = true;
  if (!changed) return;
  _syncBadge();
  if (_dock && !_dock.classList.contains("hidden")) _renderList();
}

/**
 * 挂载注入坞（index.mjs 启动时调一次）。
 * 按钮点击用 document 级委托（工具栏 DOM 可能在 init 后才就绪，与 toggles.mjs 同款理由）。
 */
export function initInjectDock() {
  _sort = storage.get(KEYS.BEILU_INJECT_DOCK_SORT) || "order";
  if (!SORTS.some(([v]) => v === _sort)) _sort = "order";

  document.addEventListener("click", (ev) => {
    const t = ev.target;
    if (!(t instanceof Element)) return;
    // 不 stopPropagation：其它浮窗（≡菜单/模型选择器）也靠 document 点击关自己，
    // 拦下来会让它们在点本按钮时留在屏上。
    if (t.closest("#single-inject-btn")) { toggleInjectDock(); return; }
    if (!_dock || _dock.classList.contains("hidden")) return;
    // 点浮窗外关闭（浮窗自身已 stopPropagation）——与项目其它浮窗一致的收起手感。
    // 例外：放大编辑的 dialog / 确认框挂在 body 下、不在浮窗子树内，点它们不该把浮窗收掉
    // （否则「⛶ 放大编辑临时一句话」一点开，回来浮窗就没了）。
    if (t.closest("dialog, .modal")) return;
    closeInjectDock();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    // 有 modal 开着时这次 Esc 归它（放大编辑 dialog / 确认框）——否则一次 Esc 连关两层
    if (document.querySelector("dialog[open], .modal.modal-open")) return;
    if (_dock && !_dock.classList.contains("hidden")) closeInjectDock();
  });
  window.addEventListener("resize", () => { if (_dock && !_dock.classList.contains("hidden")) _positionDock(); });

  // 条目/模式/IDE 连接变化 → 生效裁决随之变（后端真值，前端只重拉）；浮窗收起时不做无谓请求
  for (const evName of ["beilu:injectionPromptsChanged", "beilu:mode-switched", "beilu:ide-connected", "beilu:ide-disconnected"]) {
    window.addEventListener(evName, () => {
      if (_dock && !_dock.classList.contains("hidden")) refreshInjectDock();
    });
  }
}

/**
 * webSearchPanel.mjs — 联网设置悬浮窗
 *
 * 功能链：
 *   右栏"⚙ 联网设置"按钮 → 打开悬浮窗 → 拉取后端配置 → 用户编辑 → 保存回后端
 *   数据源：beilu-memory web_search（enabled/engine/mode/域名过滤等）+ beilu-web pluginData（autoSearch/autoBrowse/fetchTimeout 等）
 *   写回：updateConfig plugins:beilu-memory + updateWebConfig plugins:beilu-web
 *
 * 关联链：
 *   ← featureControls.mjs（initWebSearchPanel 调用入口 + _syncWebSearchFromBackend 共享同步）
 *   → sendAction（统一门面）
 *   → index.html #web-search-window（静态 HTML 骨架）
 */

import { sendAction } from "../../shared/transport/sendAction.mjs";
import { getCharId } from "../../shared/state/sharedState.mjs";
import { escapeHtml } from "../../shared/state/utils.mjs"; // T7b：escapeHtml 统一二期——收口到壳权威版

const $ = (id) => document.getElementById(id);

// ============================================================
// [0717 显示同步收口·凛倾「同一个按钮多处散写不同步」] 联网开关/引擎的全部只读显示点单源回填。
// 【why】显示点共 4 个：≡菜单 #menu-web-search / 右栏 #toggle-web-search / ≡菜单 #menu-search-engine /
//   右栏 #select-search-engine（0713 收口后全部只读，点击=打开本悬浮窗，写入唯一走 _save）。
//   原回填两份实现：featureControls._syncWebSearchFromBackend（漏 menu-web-search → ≡菜单开关
//   永远 stale，显示"关"而后端 enabled=true，P8 照常自动帮搜=用户被显示欺骗）与本文件 _save 内联
//   （四点全写）。收口为本函数（联网域唯一写入点所在模块 own 显示回填），两调用方共用。
// 消费方：_save（保存成功后）+ featureControls._syncWebSearchFromBackend（init/char-changed 拉后端权威值）。
// ============================================================
export function applyWebSearchDisplays(ws) {
  if (!ws) return;
  if (ws.enabled !== undefined) {
    [$("toggle-web-search"), $("menu-web-search")].filter(Boolean).forEach((t) => (t.checked = !!ws.enabled));
  }
  if (ws.engine) {
    [$("select-search-engine"), $("menu-search-engine")].filter(Boolean).forEach((s) => (s.value = ws.engine));
  }
}

// T7b：原 _escHtml 为 textContent/innerHTML 法（仅转 & < >，不转引号），但多数调用点用于属性上下文
// （value="${_escHtml(...)}"）——含引号值会截断属性/XSS 隐患。改用权威版 escapeHtml（含 " → &quot;、' → &#39;），
// 属性与文本上下文均兼容，属正向安全修复。alias 保调用点名 _escHtml 不变。
const _escHtml = escapeHtml;

// ============================================================
// 拖拽 + 缩放（复制 promptViewer 范式）
// ============================================================

function _initDrag() {
  const el = $("web-search-window");
  const hdr = $("ws-header");
  if (!el || !hdr) return;
  let dragging = false, sx, sy, sl, st;
  hdr.addEventListener("mousedown", (e) => {
    if (e.target.closest(".fw-controls")) return;
    dragging = true;
    el.classList.add("fw-dragging");
    const r = el.getBoundingClientRect();
    sx = e.clientX; sy = e.clientY; sl = r.left; st = r.top;
    el.style.transform = "none";
    el.style.left = sl + "px"; el.style.top = st + "px";
    e.preventDefault();
  });
  document.addEventListener("mousemove", (e) => { if (!dragging) return; el.style.left = (sl + e.clientX - sx) + "px"; el.style.top = (st + e.clientY - sy) + "px"; });
  document.addEventListener("mouseup", () => { if (dragging) { dragging = false; el.classList.remove("fw-dragging"); } });
  hdr.addEventListener("touchstart", (e) => {
    if (e.target.closest(".fw-controls")) return;
    const t = e.touches[0]; dragging = true; el.classList.add("fw-dragging");
    const r = el.getBoundingClientRect();
    sx = t.clientX; sy = t.clientY; sl = r.left; st = r.top;
    el.style.transform = "none"; el.style.left = sl + "px"; el.style.top = st + "px";
    e.preventDefault();
  }, { passive: false });
  document.addEventListener("touchmove", (e) => { if (!dragging) return; const t = e.touches[0]; el.style.left = (sl + (t.clientX - sx)) + "px"; el.style.top = (st + (t.clientY - sy)) + "px"; e.preventDefault(); }, { passive: false });
  document.addEventListener("touchend", () => { if (dragging) { dragging = false; el.classList.remove("fw-dragging"); } });
}

function _initResize() {
  const el = $("web-search-window");
  const handle = $("ws-resize-handle");
  if (!el || !handle) return;
  let resizing = false, sx, sy, sw, sh;
  handle.addEventListener("mousedown", (e) => {
    resizing = true; sx = e.clientX; sy = e.clientY; sw = el.offsetWidth; sh = el.offsetHeight;
    if (el.style.transform && el.style.transform !== "none") {
      const r = el.getBoundingClientRect();
      el.style.left = r.left + "px"; el.style.top = r.top + "px"; el.style.transform = "none";
    }
    e.preventDefault(); e.stopPropagation();
  });
  document.addEventListener("mousemove", (e) => { if (!resizing) return; el.style.width = Math.max(280, sw + e.clientX - sx) + "px"; el.style.height = Math.max(200, sh + e.clientY - sy) + "px"; });
  document.addEventListener("mouseup", () => { resizing = false; });
}

// ============================================================
// 内容渲染 + 数据加载
// ============================================================

const _STYLES = `
  .ws-grid{display:grid;grid-template-columns:1fr 1fr;gap:4px 10px;align-items:center}
  .ws-row{display:flex;align-items:center;justify-content:space-between;padding:2px 0;gap:6px}
  .ws-label{font-size:11px;white-space:nowrap}
  .ws-hint{font-size:9px;opacity:0.3}
  .ws-divider{border-top:1px solid oklch(var(--bc)/0.08);margin:5px 0}
  .ws-section{font-size:9px;opacity:0.4;letter-spacing:0.5px;text-transform:uppercase;margin:6px 0 2px}
  .ws-textarea{width:100%;min-height:20px;resize:vertical;background:oklch(var(--bc)/0.06);border:1px solid oklch(var(--bc)/0.1);border-radius:4px;padding:2px 5px;font-size:10px;color:var(--beilu-pv-value)}
  .ws-textarea::placeholder{opacity:0.25}
  .ws-textarea:focus{min-height:50px;outline:1px solid oklch(var(--pc)/0.5)}
  .ws-expand:focus{min-width:100px;outline:1px solid oklch(var(--pc)/0.5)}
  .ws-dot{width:6px;height:6px;border-radius:50%;display:inline-block}
  .ws-span2{grid-column:span 2}
  .ws-dot-ok{background:#36d399}.ws-dot-warn{background:#fbbd23}
`;

function _renderBody(memCfg, webCfg, engines) {
  const ws = memCfg || {};
  const wc = webCfg || {};
  const engineOpts = (engines || []).map(e =>
    `<option value="${_escHtml(e.value)}" ${e.value === ws.engine ? "selected" : ""}>${_escHtml(e.label || e.value)}</option>`
  ).join("");
  const crawl = wc.crawl || {};

  return `<style>${_STYLES}</style>
    <!-- 基础：2列网格 -->
    <div class="ws-grid">
      <span class="ws-label">联网搜索</span>
      <input type="checkbox" class="toggle toggle-xs toggle-success justify-self-end" id="ws-enabled" ${ws.enabled ? "checked" : ""} />
      <!-- [0726 002「不需要选择平台,直接是多平台注入」] 引擎选择降级进高级区：
           默认 multi 并发多平台，用户不必也不该关心用了哪个平台（选错=拿不到结果，是给用户挖坑）。
           不删除选项能力——排查时仍需要固定单平台复现，故移入高级而非移除。 -->
      <span class="ws-label">结果注入 <span class="ws-hint">${ws.inject_once ? "仅本轮" : "留在对话"}</span></span>
      <input type="checkbox" class="toggle toggle-xs toggle-info justify-self-end" id="ws-inject-once" ${ws.inject_once ? "checked" : ""} title="开=搜索结果只在本轮可见，不写入对话历史；关=作为对话内容保留" />
    </div>
    <div class="ws-divider"></div>
    <!-- 搜索方式：直搜 + P8 可同时开 -->
    <div class="ws-grid">
      <span class="ws-label">直接搜索 <span class="ws-hint">&lt;search&gt;</span></span>
      <input type="checkbox" class="toggle toggle-xs toggle-success justify-self-end" id="ws-auto-search" ${wc.autoSearch ? "checked" : ""} />
      <span class="ws-label">P8 搜索 <span class="ws-hint">主动帮搜</span></span>
      <input type="checkbox" class="toggle toggle-xs toggle-success justify-self-end" id="ws-p8-enabled" ${ws.p8_enabled !== false ? "checked" : ""} />
      <span class="ws-label">自动浏览 <span class="ws-hint">&lt;browse&gt;</span></span>
      <input type="checkbox" class="toggle toggle-xs toggle-warning justify-self-end" id="ws-auto-browse" ${wc.autoBrowse ? "checked" : ""} />
    </div>
    <div class="ws-row ${ws.p8_enabled === false ? "hidden" : ""}" id="ws-p8-row">
      <span class="ws-label">P8 源</span>
      <input type="text" class="input input-xs input-bordered ws-expand" id="ws-p8-source" style="flex:1;" value="${_escHtml(ws.p8_source || "")}" placeholder="沿用预设" />
    </div>
    <div class="ws-divider"></div>
    <!-- 数值参数：横排 -->
    <div class="ws-grid">
      <span class="ws-label">结果数</span>
      <input type="number" class="input input-xs input-bordered w-14 text-right justify-self-end" id="ws-max-results" value="${ws.max_results ?? 5}" min="1" />
      <span class="ws-label">每域上限 <span class="ws-hint">0=不限</span></span>
      <input type="number" class="input input-xs input-bordered w-14 text-right justify-self-end" id="ws-domain-cap" value="${ws.domain_cap ?? 2}" min="0" />
      <span class="ws-label">页面长度</span>
      <input type="number" class="input input-xs input-bordered w-14 text-right justify-self-end" id="ws-max-page" value="${wc.maxPageLength ?? 5000}" min="100" step="100" />
      <span class="ws-label">超时 ms</span>
      <input type="number" class="input input-xs input-bordered w-14 text-right justify-self-end" id="ws-timeout" value="${ws.timeout_ms ?? 8000}" min="1000" step="500" />
      <!-- [孤儿字段补入口 0713] beilu-web maxResults/fetchTimeout：后端可调（yonban/core/functions/web/main.mjs:227
           pluginData 默认 5/10000），原前端零编辑入口=孤儿（settingsSlots 死 slot initWebConfigSlot 唯一实现已删）。
           与上行「结果数/超时」区分：那是 per-char web_search 搜索参数，这两个是 beilu-web 抓取全局参数。 -->
      <span class="ws-label">抓取结果数 <span class="ws-hint">beilu-web</span></span>
      <input type="number" class="input input-xs input-bordered w-14 text-right justify-self-end" id="ws-fetch-results" value="${wc.maxResults ?? 5}" min="1" />
      <span class="ws-label">抓取超时 ms <span class="ws-hint">beilu-web</span></span>
      <input type="number" class="input input-xs input-bordered w-14 text-right justify-self-end" id="ws-fetch-timeout" value="${wc.fetchTimeout ?? 10000}" min="1000" step="500" />
    </div>
    <div class="ws-divider"></div>
    <!-- 域名过滤 -->
    <div class="ws-section">域名过滤</div>
    <div class="ws-grid">
      <div>
        <span class="ws-label">白名单</span><span class="ws-hint"> 空=不限</span>
        <div class="relative expandable-container">
          <textarea class="ws-textarea" id="ws-whitelist" rows="1" placeholder="每行一个域名" data-expandable data-expand-title="域名白名单">${_escHtml((ws.domain_whitelist || []).join("\n"))}</textarea>
          <button class="expand-btn" title="放大编辑"><i data-ic="fullscreen"></i></button>
        </div>
      </div>
      <div>
        <span class="ws-label">黑名单</span>
        <div class="relative expandable-container">
          <textarea class="ws-textarea" id="ws-blacklist" rows="1" placeholder="每行一个域名" data-expandable data-expand-title="域名黑名单">${_escHtml((ws.domain_blacklist || []).join("\n"))}</textarea>
          <button class="expand-btn" title="放大编辑"><i data-ic="fullscreen"></i></button>
        </div>
      </div>
    </div>
    <div class="ws-divider"></div>
    <!-- 高级 -->
    <details id="ws-adv">
      <summary class="ws-label cursor-pointer select-none" style="font-size:10px;opacity:0.5;list-style:none;">▸ 高级</summary>
      <div class="ws-grid" style="margin-top:4px;">
        <!-- [0726] 平台选择移入高级：默认「多平台并发」，仅排查需要固定单平台时才用 -->
        <span class="ws-label">平台 <span class="ws-hint">默认并发</span></span>
        <select class="select select-xs select-bordered justify-self-end" id="ws-engine" style="width:auto;">${engineOpts}</select>
        <span class="ws-label">正文校验 <span class="ws-hint">抓正文核相关性</span></span>
        <input type="checkbox" class="toggle toggle-xs justify-self-end" id="ws-content-verify" ${ws.content_verify !== false ? "checked" : ""} />
        <span class="ws-label">代理</span>
        <input type="text" class="input input-xs input-bordered ws-expand" id="ws-proxy" value="${_escHtml(ws.proxy_url || "")}" placeholder="http://127.0.0.1:7890" />
        <span class="ws-label">噪音过滤</span>
        <input type="checkbox" class="toggle toggle-xs justify-self-end" id="ws-noise" ${ws.noise_filter !== false ? "checked" : ""} />
        <!-- [0722 差集补入口] noise_keywords 词表：后端可配（web_search 配置 15 键之一）此前无编辑框 -->
        <div class="ws-span2">
          <span class="ws-label">噪音词表</span><span class="ws-hint"> 每行一个，命中即过滤</span>
          <div class="relative expandable-container">
            <textarea class="ws-textarea" id="ws-noise-keywords" rows="1" placeholder="每行一个关键词" data-expandable data-expand-title="噪音关键词表">${_escHtml((ws.noise_keywords || []).join("\n"))}</textarea>
            <button class="expand-btn" title="放大编辑"><i data-ic="fullscreen"></i></button>
          </div>
        </div>
        <!-- [0722 差集补入口] beilu-web maxHistory：搜索历史保留条数，后端可调此前无入口 -->
        <span class="ws-label">历史保留条数 <span class="ws-hint">beilu-web</span></span>
        <input type="number" class="input input-xs input-bordered w-14 text-right justify-self-end" id="ws-max-history" value="${wc.maxHistory ?? 50}" min="1" />
        <span class="ws-label">Tavily</span>
        <input type="password" class="input input-xs input-bordered ws-expand" id="ws-tavily" value="${_escHtml(ws.tavily_api_key || "")}" placeholder="tvly-..." />
        <span class="ws-label">SearXNG</span>
        <input type="text" class="input input-xs input-bordered ws-expand" id="ws-searxng" value="${_escHtml(ws.searxng_url || "")}" placeholder="http://..." />
        <span class="ws-label">爬取</span>
        <span class="justify-self-end" style="display:flex;align-items:center;gap:3px;font-size:10px;">
          <span class="ws-dot ${crawl.available ? "ws-dot-ok" : "ws-dot-warn"}"></span>${crawl.available ? "就绪" : "未就绪"}
        </span>
        <span class="ws-label ws-span2" style="font-size:10px;">内核目录</span>
        <input type="text" class="input input-xs input-bordered ws-expand ws-span2" id="ws-browsers-path" style="font-size:9px;" value="${_escHtml(ws.browsers_path || "")}" placeholder="留空=自动(项目根/browsers)" />
      </div>
    </details>
    <div class="ws-divider"></div>
    <div style="display:flex;gap:4px;">
      <button class="btn btn-xs btn-primary flex-1" id="ws-save">保存</button>
      <button class="btn btn-xs btn-ghost flex-1" id="ws-check" style="font-size:10px;">检查</button>
    </div>
    <div id="ws-status" class="text-xs text-center mt-1 hidden"></div>
    <div id="ws-diag" class="hidden" style="margin-top:4px;"></div>`;
}

// ============================================================
// 数据加载 + 保存
// ============================================================

async function _loadAndRender() {
  const body = $("ws-body");
  if (!body) return;
  try {
    const [memData, webData] = await Promise.all([
      sendAction({ verb: "getData", target: "plugins:beilu-memory", source: "web" }),
      sendAction({ verb: "getData", target: "plugins:beilu-web", source: "web" }),
    ]);
    const ws = memData?.config?.web_search || {};
    const engines = memData?.web_search_engines || [];
    body.innerHTML = _renderBody(ws, webData, engines);
    _bindEvents();
  } catch (e) {
    body.innerHTML = `<p class="text-xs text-error p-2">加载失败: ${_escHtml(e.message)}</p>`;
  }
}

function _parseLines(text) {
  return text.split("\n").map(s => s.trim()).filter(Boolean);
}

function _bindEvents() {
  const p8Toggle = $("ws-p8-enabled");
  const p8Row = $("ws-p8-row");
  if (p8Toggle && p8Row) {
    p8Toggle.addEventListener("change", () => {
      p8Row.classList.toggle("hidden", !p8Toggle.checked);
    });
  }

  const adv = $("ws-adv");
  if (adv) {
    adv.addEventListener("toggle", function () {
      const s = this.querySelector("summary");
      if (s) s.textContent = this.open ? "▾ 高级" : "▸ 高级";
    });
  }

  const saveBtn = $("ws-save");
  if (saveBtn) saveBtn.addEventListener("click", _save);

  const checkBtn = $("ws-check");
  if (checkBtn) checkBtn.addEventListener("click", _diagnose);
}

async function _save() {
  const statusEl = $("ws-status");
  const _show = (msg, cls) => { if (!statusEl) return; statusEl.textContent = msg; statusEl.className = `text-xs text-center mt-1 ${cls}`; statusEl.classList.remove("hidden"); if (cls === "text-success") setTimeout(() => statusEl.classList.add("hidden"), 2000); };

  const charId = getCharId();
  if (!charId) { _show("无角色上下文", "text-error"); return; }

  try {
    const webSearch = {
      enabled: $("ws-enabled")?.checked ?? false,
      // 兜底与后端默认单点对齐（storage schema DEFAULT_ENGINE / SUPPORTED_ENGINES 首项）。
      // ⚠ 0726 踩过：这里写死 "browser" 时，用户一保存就把后端刚升级的 multi 写回旧值，
      //   后端默认改动被前端悄悄覆盖（典型时序陷阱）。改默认必须两侧同步。
      engine: $("ws-engine")?.value || "multi",
      p8_enabled: $("ws-p8-enabled")?.checked ?? true,
      inject_once: $("ws-inject-once")?.checked ?? false, // 单次注入=结果不写入对话历史
      content_verify: $("ws-content-verify")?.checked ?? true,
      max_results: Number($("ws-max-results")?.value) || 5,
      // 0=不限 是合法值，不能用 ||（会把 0 打成默认 2）
      domain_cap: Math.max(0, parseInt($("ws-domain-cap")?.value, 10) || 0),
      timeout_ms: Number($("ws-timeout")?.value) || 8000,
      noise_filter: $("ws-noise")?.checked ?? true,
      proxy_url: $("ws-proxy")?.value?.trim() || "",
      tavily_api_key: $("ws-tavily")?.value?.trim() || "",
      searxng_url: $("ws-searxng")?.value?.trim() || "",
      browsers_path: $("ws-browsers-path")?.value?.trim() || "",
      p8_source: $("ws-p8-source")?.value?.trim() || "",
      domain_whitelist: _parseLines($("ws-whitelist")?.value || ""),
      domain_blacklist: _parseLines($("ws-blacklist")?.value || ""),
      // [0722 差集补入口] 噪音词表：后端可配此前无编辑框
      noise_keywords: _parseLines($("ws-noise-keywords")?.value || ""),
    };

    const webConfig = {
      autoSearch: $("ws-auto-search")?.checked ?? true,
      autoBrowse: $("ws-auto-browse")?.checked ?? false,
      // [0722 差集补入口] beilu-web 插件总开关与「联网搜索」开关联动单一 UI（两处 enabled 语义合一，
      // 避免面板出现两个"启用"开关让用户困惑；关总开关=GetPrompt/ReplyHandler 全停）
      enabled: $("ws-enabled")?.checked ?? false,
    };
    // maxHistory：有值才提交（空=不覆盖后端已有，同 maxPageLength 模式）
    const _mh = $("ws-max-history")?.value?.trim();
    if (_mh) webConfig.maxHistory = Number(_mh);
    const mp = $("ws-max-page")?.value?.trim();
    if (mp) webConfig.maxPageLength = Number(mp);
    // [孤儿字段补入口 0713] 与 maxPageLength 同模式：有值才提交（空=不覆盖后端已有）
    const _fr = $("ws-fetch-results")?.value?.trim();
    if (_fr) webConfig.maxResults = Number(_fr);
    const _ft = $("ws-fetch-timeout")?.value?.trim();
    if (_ft) webConfig.fetchTimeout = Number(_ft);
    // [2026-08-01 批② browsersPath 口径分裂修] 前端同步写 beilu-web 的 _browsersPath——
    //   原来 browsers_path 只写进 beilu-memory per-char 配置，beilu-web crawlProbe 读自己的空键=断链。
    webConfig.browsersPath = webSearch.browsers_path || "";

    await Promise.all([
      sendAction({ verb: "updateConfig", target: "plugins:beilu-memory", source: "web", payload: { charName: charId, web_search: webSearch } }),
      sendAction({ verb: "updateWebConfig", target: "plugins:beilu-web", source: "web", payload: webConfig }),
    ]);

    // [0717 显示同步收口] 保存成功后经单源回填函数刷新全部只读显示点（原此处内联写两 toggle+两 select
    //   =与 featureControls._syncWebSearchFromBackend 的第二份同构实现，且那份漏了 menu-web-search
    //   → ≡菜单开关永远 stale=凛倾截图"同一个按钮多处散写不同步"病灶）
    applyWebSearchDisplays(webSearch);

    _show("已保存", "text-success");
  } catch (e) {
    _show("保存失败: " + e.message, "text-error");
  }
}

async function _diagnose() {
  const diagEl = $("ws-diag");
  if (!diagEl) return;
  diagEl.classList.remove("hidden");
  diagEl.innerHTML = `<div class="text-xs opacity-50">检查中...</div>`;

  try {
    const memData = await sendAction({ verb: "getData", target: "plugins:beilu-memory", source: "web" });
    const wsConfig = memData?.config?.web_search || {};

    const result = await sendAction({
      verb: "updateWebConfig", target: "plugins:beilu-web", source: "web",
      payload: { _action: "diagnose", config: wsConfig },
    });

    const nodes = result?.nodes || [];
    if (nodes.length === 0) {
      diagEl.innerHTML = `<div class="text-xs text-warning">诊断返回空结果</div>`;
      return;
    }

    diagEl.innerHTML = nodes.map(n => {
      const icon = n.ok ? '<span class="ws-dot ws-dot-ok"></span>' : '<span class="ws-dot" style="background:#f87272"></span>';
      const ms = n.ms > 0 ? ` <span style="opacity:0.4">${n.ms}ms</span>` : "";
      const detail = _escHtml(n.detail || "").replace(/\n/g, "<br>");
      return `<div style="margin-bottom:6px;padding:4px 6px;background:oklch(var(--bc)/0.04);border-radius:4px;font-size:10.5px;">
        <div style="display:flex;align-items:center;gap:4px;">
          ${icon} <b>${_escHtml(n.name)}</b>${ms}
        </div>
        <div style="opacity:0.6;margin-top:2px;white-space:pre-wrap;word-break:break-all;">${detail}</div>
      </div>`;
    }).join("");
  } catch (e) {
    diagEl.innerHTML = `<div class="text-xs text-error">检查失败: ${_escHtml(e.message)}</div>`;
  }
}

// ============================================================
// 初始化
// ============================================================

export function initWebSearchPanel() {
  const win = $("web-search-window");
  const trigger = $("open-web-search-settings");
  const closeBtn = $("ws-close");
  if (!win || !trigger) return;

  _initDrag();
  _initResize();

  trigger.addEventListener("click", () => {
    const wasHidden = win.classList.contains("hidden");
    win.classList.toggle("hidden");
    if (wasHidden) {
      // 定位到触发按钮附近（不硬编码固定位置）
      const btnRect = trigger.getBoundingClientRect();
      const winW = win.offsetWidth || 320;
      let left = btnRect.left - winW - 8;
      if (left < 8) left = btnRect.right + 8;
      let top = btnRect.top;
      if (top + 400 > window.innerHeight) top = Math.max(8, window.innerHeight - 500);
      win.style.transform = "none";
      win.style.left = left + "px";
      win.style.top = top + "px";
      _loadAndRender();
    }
  });

  if (closeBtn) closeBtn.addEventListener("click", () => win.classList.add("hidden"));

  // ESC 关闭
  if (window._beiluEscRegistry) {
    window._beiluEscRegistry.push({
      _id: "web-search-window",
      priority: 20,
      isOpen: () => !win.classList.contains("hidden"),
      close: () => win.classList.add("hidden"),
    });
  }
}

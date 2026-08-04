/**
 * extensionsPanel.mjs — 额外插件管理平台（完整 Tab 面板模式）
 *
 * 功能链：aux-menu data-aux="extensions" → switchTab("extensions") → beilu:tab-activated
 *   → initExtensionsPanel() 懒初始化 → 渲染左侧插件导航 + 右侧内容区
 *
 * 容器：#center-tab-extensions 内部的 #ext-nav（左导航）+ #ext-content（右内容）
 *
 * 扩展方式：在 PLUGINS 数组追加 {id, label, icon, desc, render(container)} 即可注册新插件前端
 */

import { storage } from "../../shared/state/storage.mjs";
// 0722 散写收口:recordDevice/serverDenoise 有第二消费域(桌宠🎤读 petSettings),写必须双 store——
// 此前本面板只写 localStorage,从这里改设备/降噪桌宠🎤吃旧值。双写唯一 owner=sttSettings.mjs。
import { setSttRecordDevice, setSttServerDenoise } from "../../shared/state/sttSettings.mjs";

// ============================================================
// 插件注册表 — 新增插件在此追加
// ============================================================

const PLUGINS = [
  { id: "stt", label: "语音转录", icon: "mic", desc: "MOSS-Transcribe-Diarize · 本地语音转文字 · 说话人分离", render: renderSttPlugin },
  { id: "reach", label: "平台触达", icon: "earth", desc: "13 个互联网平台结构化数据 · Twitter · B站 · YouTube · GitHub", render: renderReachPlugin },
  { id: "browser", label: "浏览器自动化", icon: "web", desc: "CDP 协议控制浏览器 · 导航/点击/输入/快照/截图", render: renderBrowserPlugin },
  // 0722 差集审计补面：以下插件此前后端有配置、前端零入口（后端权威模式，meta 单源下发）
  { id: "vectordb", label: "语义搜索", icon: "database",
    desc: "Orama 向量数据库 · 记忆全文/语义/混合检索",
    render: _makeBackendSchemaPanel({ title: "语义搜索 (VectorDB)", desc: "Orama 向量数据库 · 记忆全文/语义/混合检索 · 需配置 Embedding API", base: "/api/parts/plugins:beilu-vectordb" }) },
  { id: "ppt", label: "PPT 生成", icon: "presentation",
    desc: "AI 多步组装 PPT · 渲染/转换/校准管线",
    render: _makeBackendSchemaPanel({ title: "PPT 生成", desc: "AI 通过 <ppt_op> 标签多步组装 PPT · 管线渲染/可编辑 pptx 转换", base: "/api/parts/plugins:beilu-ppt" }) },
  // 【红线·0731 凛倾拍板"mvu重复+多处散写,直接把额外插件那边删除"】MVU/EJS 是酒馆角色卡适配件，
  //   开关唯一控制面=AIRP「脚本插件管理」（stCompat/pluginManager.mjs，同步后端 config 单源）。
  //   本平台禁止再列 beilu-mvu/beilu-ejs 条目——双面板同写一份后端 config = 散写，用户在一处关
  //   另一处看还开着（0731 事故）。
];

// ============================================================
// STT 存储键 & 默认值
// ============================================================

const STT_KEYS = {
  enabled:        "beilu-stt-enabled",
  pythonExe:      "beilu-stt-python-exe",
  modelPath:      "beilu-stt-model-path",
  port:           "beilu-stt-port",
  language:       "beilu-stt-language",
  maxTokens:      "beilu-stt-max-tokens",
  hotwords:       "beilu-stt-hotwords",
  showSpeakers:   "beilu-stt-show-speakers",
  autoTranscribe: "beilu-stt-auto-transcribe",
  denoise:        "beilu-stt-denoise",
  backendRecord:  "beilu-stt-backend-record",
  recordDevice:   "beilu-stt-record-device",
  serverDenoise:  "beilu-stt-server-denoise",
};

const STT_DEFAULTS = {
  // 主输入栏麦克风是“语音转文字”入口，不是录音附件入口；新用户默认启用。
  enabled:        "true",
  pythonExe:      "python",
  modelPath:      "",
  port:           "7861",
  language:       "auto",
  maxTokens:      "8192",
  hotwords:       "",
  showSpeakers:   "true",
  autoTranscribe: "true",
  denoise:        "true",
  backendRecord:  "true",
  recordDevice:   "",
  serverDenoise:  "true",
};

const STT_LANGUAGES = [
  { value: "auto", label: "自动检测" },
  { value: "zh",   label: "中文" },
  { value: "en",   label: "English" },
  { value: "ja",   label: "日本語" },
  { value: "ko",   label: "한국어" },
  { value: "es",   label: "Español" },
  { value: "fr",   label: "Français" },
  { value: "de",   label: "Deutsch" },
  { value: "pt",   label: "Português" },
  { value: "ru",   label: "Русский" },
];

// ============================================================
// 面板状态
// ============================================================

let _initialized = false;
let _activePlugin = "";

// ============================================================
// 初始化（懒加载，首次切到 extensions tab 时触发）
// ============================================================

export function initExtensionsPanel() {
  if (_initialized) return;
  _initialized = true;

  const nav = document.getElementById("ext-nav");
  const backBtn = document.getElementById("ext-back-btn");

  if (backBtn) {
    backBtn.addEventListener("click", () => {
      window.dispatchEvent(new CustomEvent("beilu:switchTab", { detail: { tab: "chat" } }));
    });
  }

  if (nav) _renderNav(nav);
  if (PLUGINS.length) _selectPlugin(PLUGINS[0].id);
}

window.addEventListener("beilu:tab-activated", (e) => {
  if (e.detail === "extensions") initExtensionsPanel();
});

// ============================================================
// 左侧导航
// ============================================================

function _renderNav(nav) {
  const titleEl = nav.querySelector(".ext-panel-nav-title");
  const frag = document.createDocumentFragment();

  for (const p of PLUGINS) {
    const btn = document.createElement("button");
    btn.className = "ext-panel-nav-item";
    btn.dataset.extId = p.id;
    btn.innerHTML = `<i data-ic="${p.icon}"></i> <span>${p.label}</span>`;
    btn.addEventListener("click", () => _selectPlugin(p.id));
    frag.appendChild(btn);
  }

  // 分隔线 + 添加插件占位
  const hr = document.createElement("hr");
  hr.style.cssText = "border:none; border-top:1px solid var(--color-base-300); margin:8px 0;";
  frag.appendChild(hr);

  const addBtn = document.createElement("button");
  addBtn.className = "ext-panel-nav-item";
  addBtn.style.opacity = "0.4";
  addBtn.innerHTML = '<i data-ic="plus"></i> <span>更多插件...</span>';
  addBtn.addEventListener("click", () => {
    window._beiluToast?.("更多插件即将推出", "info");
  });
  frag.appendChild(addBtn);

  if (titleEl) titleEl.after(frag);
  else nav.appendChild(frag);
}

// ============================================================
// 插件切换
// ============================================================

function _selectPlugin(id) {
  _activePlugin = id;
  const nav = document.getElementById("ext-nav");
  if (nav) {
    nav.querySelectorAll(".ext-panel-nav-item").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.extId === id);
    });
  }

  const content = document.getElementById("ext-content");
  if (!content) return;

  const welcome = document.getElementById("ext-welcome");
  if (welcome) welcome.style.display = "none";

  const plugin = PLUGINS.find((p) => p.id === id);
  if (!plugin) {
    content.innerHTML = '<p class="text-xs opacity-40">未知插件</p>';
    return;
  }

  content.innerHTML = "";
  plugin.render(content);
}

// ============================================================
// 工具函数
// ============================================================

function _sttGet(key) {
  const v = storage.get(STT_KEYS[key]);
  return (v !== null && v !== undefined && v !== "") ? v : STT_DEFAULTS[key];
}

function _sttSet(key, value) {
  storage.set(STT_KEYS[key], String(value));
}

function _h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "style" && typeof v === "object") Object.assign(el.style, v);
      else if (k === "className") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2).toLowerCase(), v);
      else el.setAttribute(k, v);
    }
  }
  for (const c of children) {
    if (typeof c === "string") el.appendChild(document.createTextNode(c));
    else if (c) el.appendChild(c);
  }
  return el;
}

function _settingRow(label, desc, control) {
  const row = _h("div", { className: "ext-setting-row" },
    _h("div", { className: "ext-setting-label" },
      _h("div", { className: "label-main" }, label),
      desc ? _h("div", { className: "label-desc" }, desc) : null,
    ),
    _h("div", { className: "ext-setting-control" }, control),
  );
  return row;
}

function _settingBlock(label, desc, control) {
  return _h("div", { className: "ext-setting-block" },
    _h("div", { className: "ext-setting-label" },
      _h("div", { className: "label-main" }, label),
      desc ? _h("div", { className: "label-desc" }, desc) : null,
    ),
    control,
  );
}

// ============================================================
// schema 驱动控件渲染（凛倾 0722 禁前端硬编码）：
// 控件类型/label/desc/min/max/step/options/placeholder 全部来自后端 meta，
// 前端只做渲染与读写桥（get/set 走 localStorage + 后端同步），零限值/默认值/选项副本。
// ============================================================
function _renderMetaControl(m, get, set) {
  const cur = get(m.key);
  switch (m.type) {
    case "toggle": {
      const el = _h("input", { type: "checkbox", className: "toggle toggle-sm toggle-warning" });
      el.checked = String(cur) !== "false";
      el.addEventListener("change", () => set(m.key, el.checked));
      return _settingRow(m.label, m.desc, el);
    }
    case "number": {
      const attrs = { type: "number", className: "input input-sm input-bordered ext-input-num" };
      if (m.min !== undefined) attrs.min = String(m.min);
      if (m.max !== undefined) attrs.max = String(m.max);
      if (m.step !== undefined) attrs.step = String(m.step);
      const el = _h("input", attrs);
      el.value = String(cur ?? "");
      el.addEventListener("change", () => {
        const v = parseInt(el.value, 10);
        if (!Number.isNaN(v) && (m.min === undefined || v >= m.min) && (m.max === undefined || v <= m.max)) set(m.key, v);
      });
      return _settingRow(m.label, m.desc, el);
    }
    case "range": {
      const div = m.unitDiv || 1;
      const val = _h("span", { className: "ext-range-val" });
      const show = (v) => { val.textContent = (v / div) + (m.unit || ""); };
      const el = _h("input", { type: "range", className: "range range-xs range-warning", min: String(m.min), max: String(m.max), step: String(m.step) });
      el.value = String(parseInt(cur, 10) || m.min);
      show(parseInt(el.value, 10));
      el.addEventListener("input", () => { show(parseInt(el.value, 10)); set(m.key, el.value); });
      const box = _h("div", { className: "ext-range-wrap" }, el, val);
      return _settingRow(m.label, m.desc, box);
    }
    case "select": {
      const el = _h("select", { className: "select select-sm select-bordered" });
      for (const opt of m.options || []) {
        const o = _h("option", { value: opt.value }, opt.label);
        if (opt.value === cur) o.selected = true;
        el.appendChild(o);
      }
      el.addEventListener("change", () => set(m.key, el.value));
      return _settingRow(m.label, m.desc, el);
    }
    case "password":
    case "text":
    default: {
      const attrs = { type: m.type === "password" ? "password" : "text", className: "input input-sm input-bordered w-full", placeholder: m.placeholder || (m.type === "password" ? "未配置" : "") };
      const el = _h("input", attrs);
      el.value = m.escapeNewline ? String(cur ?? "").replace(/\n/g, "\\n") : String(cur ?? "");
      el.addEventListener("change", () => {
        const raw = el.value.trim();
        set(m.key, m.escapeNewline ? raw.replace(/\\n/g, "\n") : raw);
      });
      return _settingBlock(m.label, m.desc, el);
    }
  }
}

/** 按 meta.group 分组渲染整套控件（组标题+控件顺序 = 后端声明顺序） */
function _renderMetaGroups(wrap, meta, get, set) {
  let lastGroup = null;
  for (const m of meta) {
    if (m.group !== lastGroup) {
      wrap.appendChild(_h("h3", { className: "ext-subsection-title" }, m.group));
      lastGroup = m.group;
    }
    wrap.appendChild(_renderMetaControl(m, get, set));
  }
}

/**
 * 后端权威 schema 面板工厂（凛倾 0722"好多后端的设置前端都没有"差集补齐）：
 * 适用配置在后端落盘的插件（vectordb/ppt/mvu）——读=getdata（含 meta 控件声明+现值），
 * 写=setdata 直达后端（setdataWrap 声明 _action 包装），不经 localStorage（读写同源=后端）。
 * 脱敏键（meta.skipEmpty）：现值不回显、留空不发送=保持后端已有值。
 */
function _makeBackendSchemaPanel({ title, desc, base }) {
  return function render(container) {
    const wrap = _h("div", { className: "ext-wrap" });
    wrap.appendChild(_h("div", { className: "ext-title-area" },
      _h("h2", { className: "ext-section-title" }, title),
      _h("p", { className: "ext-section-desc" }, desc)));
    const host = _h("div", null);
    wrap.appendChild(host);
    container.appendChild(wrap);

    async function load() {
      host.innerHTML = "";
      let data;
      try {
        const r = await fetch(base + "/config/getdata");
        if (!r.ok) throw new Error(String(r.status));
        data = await r.json();
      } catch {
        host.appendChild(_schemaUnavailableCard(load));
        return;
      }
      const metaByKey = Object.fromEntries((data.meta || []).map((m) => [m.key, m]));
      const get = (k) => {
        if (metaByKey[k]?.skipEmpty) return ""; // 脱敏键不回显现值（placeholder 提示是否已配置）
        const v = data[k];
        return v === undefined || v === null ? "" : String(v);
      };
      const set = async (k, v) => {
        const m = metaByKey[k];
        if (m?.skipEmpty && (v === "" || v === undefined)) return; // 留空=保持后端已有值
        let val = v;
        if (m?.type === "toggle") val = v === true || String(v) === "true";
        else if (m?.type === "number" || m?.type === "range") val = parseInt(v, 10);
        const body = data.setdataWrap ? { _action: data.setdataWrap, [k]: val } : { [k]: val };
        try {
          const r = await fetch(base + "/config/setdata", {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
          });
          if (!r.ok) throw new Error(String(r.status));
          window._beiluToast?.("已保存", "info");
        } catch (e) {
          window._beiluToast?.("保存失败: " + e.message, "error");
        }
      };
      _renderMetaGroups(host, data.meta || [], get, set);
    }
    load();
  };
}

/** 后端 schema 未生效（未重启）时的诚实降级提示卡 */
function _schemaUnavailableCard(retry) {
  const card = _h("div", { className: "ext-status-card" },
    _h("div", { className: "ext-guide-text" },
      "设置项定义来自后端（默认值/限值/选项单源），当前后端尚未加载新版本——重启 beilu 后本面板即可用。"),
  );
  card.appendChild(_h("div", { className: "ext-btn-group" },
    _h("button", { className: "btn btn-sm btn-outline", onClick: retry }, "重试")));
  return card;
}

// ============================================================
// STT 插件完整界面
// ============================================================

// ── STT 使用引导卡：四步状态(Python/模型/服务/麦克风) + 模型联网下载(直链/镜像/进度) ──
function _renderSttGuide() {
  const card = _h("div", {
    style: {
      background: "var(--beilu-surface)", borderRadius: "10px",
      padding: "16px", marginBottom: "20px",
      border: "1px solid var(--color-base-300)",
    },
  });
  card.appendChild(_h("div", { style: { fontWeight: "600", fontSize: "14px", marginBottom: "10px", color: "var(--beilu-amber-fg)" } }, "使用引导"));

  const mkStep = (title) => {
    const dot = _h("span", { className: "ext-status-dot stopped" });
    const text = _h("span", { style: { fontSize: "12px", opacity: "0.85" } }, "检测中...");
    const extra = _h("div", { style: { marginTop: "6px", display: "none" } });
    const row = _h("div", { style: { padding: "6px 0" } },
      _h("div", { style: { display: "flex", alignItems: "center", gap: "8px" } },
        dot, _h("span", { style: { fontSize: "13px", fontWeight: "500", minWidth: "88px" } }, title), text),
      extra,
    );
    return { row, dot, text, extra };
  };
  const stepPy = mkStep("① Python");
  const stepModel = mkStep("② 模型文件");
  const stepSvc = mkStep("③ STT 服务");
  const stepMic = mkStep("④ 麦克风");
  for (const s of [stepPy, stepModel, stepSvc, stepMic]) card.appendChild(s.row);

  // 模型下载区（步骤②的动作区）
  const selSrc = _h("select", { className: "select select-xs select-bordered" });
  const btnDl = _h("button", { className: "btn btn-xs btn-outline" }, "下载模型");
  const btnCancel = _h("button", { className: "btn btn-xs btn-outline", style: { display: "none" } }, "取消");
  const prog = _h("progress", { className: "progress progress-warning", max: "100", value: "0", style: { width: "220px", display: "none" } });
  const progText = _h("span", { style: { fontSize: "11px", opacity: "0.7" } });
  stepModel.extra.append(selSrc, btnDl, btnCancel, prog, progText);
  stepModel.extra.style.display = "none";
  stepModel.extra.style.gap = "6px";
  stepModel.extra.style.alignItems = "center";

  const _set = (s, ok, msg, warn) => {
    s.dot.className = "ext-status-dot " + (ok ? "running" : warn ? "starting" : "stopped");
    s.text.textContent = msg;
  };
  const _fmtGB = (b) => (b / 1073741824).toFixed(2) + " GB";

  async function loadSources() {
    try {
      const r = await fetch("/api/parts/plugins:beilu-stt/model/sources");
      if (!r.ok) return;
      const j = await r.json();
      selSrc.innerHTML = "";
      for (const s of j.sources || []) selSrc.appendChild(_h("option", { value: s.id }, s.label));
    } catch { /* beilu 未重启时 404,refresh 已提示 */ }
  }

  let _pollTimer = null;
  let _pollFails = 0;
  const _fmtSpeed = (bps) => bps >= 1048576 ? (bps / 1048576).toFixed(1) + " MB/s" : Math.round(bps / 1024) + " KB/s";
  const _fmtEta = (s) => s == null ? "" : (s >= 3600 ? `${Math.floor(s / 3600)}h${Math.floor(s % 3600 / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`);
  async function pollProgress() {
    try {
      const r = await fetch("/api/parts/plugins:beilu-stt/model/progress");
      const j = await r.json();
      _pollFails = 0;
      if (j.running) {
        prog.style.display = ""; btnCancel.style.display = ""; btnDl.style.display = "none";
        const pct = j.totalBytes ? Math.floor(j.doneBytes / j.totalBytes * 100) : 0;
        prog.value = pct;
        // [D5 §2.3] Job DTO 消费:phase 优先(cancelling=收束中;selecting=选源不阻断下载的诚实文案由后端 note 下发)
        const _phasePrefix = j.phase === "cancelling" ? "正在取消（在途连接收束中）… · " : "";
        progText.textContent = _phasePrefix +
          `${pct}% · ${_fmtGB(j.doneBytes)}/${_fmtGB(j.totalBytes)}` +
          (j.speedBps ? ` · ${_fmtSpeed(j.speedBps)}` : "") +
          (j.etaS != null ? ` · 剩余${_fmtEta(j.etaS)}` : "") +
          (j.source ? ` · 源:${j.source}` : "") +
          ` · ${j.currentFile || ""} (${j.filesDone}/${j.filesTotal})` +
          (j.note ? ` · ${j.note}` : "") +
          (j.retries ? ` · 累计重试${j.retries}` : "");
        _pollTimer = setTimeout(pollProgress, 2000);
      } else {
        prog.style.display = "none"; btnCancel.style.display = "none"; btnDl.style.display = "";
        // 终态按 phase 分项(D5 §2.3/§4):cancelled 不是失败——「已取消，已下载部分已保留，下次继续」;
        //   failed 才显示错误(probe 明细已在后端 error/note 内);旧后端无 phase 时回退旧判据。
        if (j.phase === "cancelled") progText.textContent = "已取消，已下载部分已保留，下次继续";
        else if (j.phase === "completed" || j.finished) progText.textContent = "下载完成";
        else if (j.error) progText.textContent = `下载失败: ${j.error}（.part 已保留,再点下载即从断点续传）`;
        else progText.textContent = "";
        if (j.installed) refresh();
      }
    } catch {
      // 轮询自身遇网络波动:退避重试,连续 5 次失败才停(下载在后端继续,不受影响)
      if (++_pollFails <= 5) {
        progText.textContent = `进度获取失败,重试中(${_pollFails}/5)——后台下载不受影响`;
        _pollTimer = setTimeout(pollProgress, 3000 * _pollFails);
      } else {
        progText.textContent = "进度获取中断——点「重新检测」恢复显示,后台下载不受影响";
      }
    }
  }

  btnDl.addEventListener("click", async () => {
    try {
      const r = await fetch("/api/parts/plugins:beilu-stt/model/download", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: selSrc.value }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return window._beiluToast?.("下载启动失败: " + (j.error || r.status), "error");
      window._beiluToast?.("模型下载已开始（约 1.8GB）", "info");
      pollProgress();
    } catch (e) { window._beiluToast?.("下载启动失败: " + e.message, "error"); }
  });
  btnCancel.addEventListener("click", async () => {
    await fetch("/api/parts/plugins:beilu-stt/model/cancel", { method: "POST" }).catch(() => {});
  });

  async function refresh() {
    const q = new URLSearchParams();
    const py = _sttGet("pythonExe"); const mp = storage.get(STT_KEYS.modelPath) || "";
    if (py) q.set("pythonExe", py);
    if (mp) q.set("modelPath", mp);
    let env = null;
    try {
      const r = await fetch(`/api/parts/plugins:beilu-stt/env/check?${q}`);
      if (r.status === 404) {
        for (const s of [stepPy, stepModel, stepSvc]) _set(s, false, "环境检测端点未生效——重启 beilu 后可用", true);
        return;
      }
      env = await r.json();
    } catch (e) {
      for (const s of [stepPy, stepModel, stepSvc]) _set(s, false, "检测失败: " + e.message, true);
      return;
    }
    _set(stepPy, env.python?.ok, env.python?.ok ? `${env.python.detail}（${env.python.exe}）` : `不可用: ${env.python?.detail}——请安装 Python 3.10+ 或在高级设置指定路径`);
    if (env.model?.installed) {
      _set(stepModel, true, `已安装 · ${_fmtGB(env.model.bytes)} · ${env.model.path}`);
      stepModel.extra.style.display = "none";
    } else {
      _set(stepModel, false, `未安装（目标: ${env.model?.defaultPath}）——选择下载源后点「下载模型」`);
      stepModel.extra.style.display = "flex";
      loadSources();
      pollProgress();
    }
    const svcSu = env.service?.startup;
    if (env.service?.running && svcSu && svcSu.phase !== "ready" && svcSu.phase !== "failed") {
      // 启动中(加载模型可达1-2分钟):显示阶段+已用时长,不显示成"未运行"引导用户重复点启动
      _set(stepSvc, false, `启动中 · ${svcSu.label}${svcSu.pct != null ? ` ${svcSu.pct}%` : ""} · 已用 ${svcSu.elapsedS}s`, true);
    } else {
      _set(stepSvc, env.service?.running, env.service?.running ? `运行中 (PID ${env.service.pid})` : "未运行——在下方「服务状态」卡启动", !env.service?.running);
    }
    _set(stepMic, true, "在下方「录音设备」点「找活麦」自动选电平最高的设备（建议边说话边点）", false);
    stepMic.dot.className = "ext-status-dot starting";
  }

  const btnRefresh = _h("button", { className: "btn btn-xs btn-outline", style: { marginTop: "8px" }, onClick: refresh }, "重新检测");
  card.appendChild(btnRefresh);
  refresh();
  return card;
}

function renderSttPlugin(container) {
  const wrap = _h("div", { style: { maxWidth: "640px" } });

  // ── 标题区 ──
  wrap.appendChild(_h("div", { style: { marginBottom: "24px" } },
    _h("h2", { className: "ext-section-title" }, "语音转录 (STT)"),
    _h("p", { className: "ext-section-desc" },
      "基于 MOSS-Transcribe-Diarize 0.9B · 本地推理 · 支持 50+ 语言 · 说话人分离 · 时间戳"),
  ));

  // ── 使用引导卡（环境状态检测 + 模型下载,数据源=后端 /env/check 单源）──
  wrap.appendChild(_renderSttGuide());

  // ── 服务状态卡片 ──
  const statusCard = _h("div", {
    style: {
      background: "var(--beilu-surface)", borderRadius: "10px",
      padding: "16px", marginBottom: "20px",
      border: "1px solid var(--color-base-300)",
    },
  });
  const statusDot = _h("span", { className: "ext-status-dot stopped" });
  const statusText = _h("span", { style: { fontSize: "13px" } }, "服务未运行");
  const statusRow = _h("div", { style: { display: "flex", alignItems: "center", gap: "8px", marginBottom: "12px" } },
    statusDot, statusText,
  );
  statusCard.appendChild(statusRow);

  const btnStart = _h("button", {
    className: "btn btn-sm btn-outline",
    onClick: () => _sttServiceAction("start", statusDot, statusText, sttStartUi),
  }, "启动服务");
  const btnStop = _h("button", {
    className: "btn btn-sm btn-outline",
    onClick: () => _sttServiceAction("stop", statusDot, statusText, sttStartUi),
  }, "停止服务");
  const btnTest = _h("button", {
    className: "btn btn-sm btn-outline",
    onClick: () => _sttServiceAction("test", statusDot, statusText),
  }, "测试连接");
  statusCard.appendChild(_h("div", { className: "ext-btn-group" }, btnStart, btnStop, btnTest));
  // 启动进度行（消费后端 /status.startup 单源）:加载模型阶段可达 1-2 分钟,
  // 无进度反馈时用户会以为没启动/坏了反复点启动（20260724 截图实证刷屏）
  const startProg = _h("progress", { className: "progress progress-warning", max: "100", style: { width: "220px" } });
  const startText = _h("span", { style: { fontSize: "11px", opacity: "0.75" } });
  const startRow = _h("div", { style: { display: "none", alignItems: "center", gap: "8px", marginTop: "10px" } }, startProg, startText);
  statusCard.appendChild(startRow);
  const sttStartUi = { btnStart, startRow, startProg, startText };
  wrap.appendChild(statusCard);

  // ── 基础设置 ──
  wrap.appendChild(_h("h3", { className: "ext-subsection-title" }, "基础设置"));

  // 1. 启用开关
  const toggleEn = _h("input", { type: "checkbox", className: "toggle toggle-sm toggle-warning" });
  toggleEn.checked = _sttGet("enabled") === "true";
  toggleEn.addEventListener("change", () => _sttSet("enabled", toggleEn.checked));
  wrap.appendChild(_settingRow("启用语音转录", "关闭时麦克风会停止使用，不会改成音频附件；开启后录音完成调用 STT 服务转文字", toggleEn));

  // 2. 自动转录
  const toggleAuto = _h("input", { type: "checkbox", className: "toggle toggle-sm toggle-warning" });
  toggleAuto.checked = _sttGet("autoTranscribe") !== "false";
  toggleAuto.addEventListener("change", () => _sttSet("autoTranscribe", toggleAuto.checked));
  wrap.appendChild(_settingRow("自动转录", "开=录完直接转录；关=录完先弹审查窗（试听回放+电平白盒），手动点「转文本」", toggleAuto));

  // 2.5 麦克风降噪（浏览器原生 WebRTC 音频处理链，getUserMedia 约束在 messageInput.mjs 录音入口消费）
  const toggleDn = _h("input", { type: "checkbox", className: "toggle toggle-sm toggle-warning" });
  toggleDn.checked = _sttGet("denoise") !== "false";
  toggleDn.addEventListener("change", () => _sttSet("denoise", toggleDn.checked));
  wrap.appendChild(_settingRow("麦克风降噪", "录音时启用浏览器降噪 / 回声消除 / 自动增益（仅浏览器录音方式生效）", toggleDn));

  // 2.55 降噪+拾音(服务端管线,凛倾 0722):增益归一化→DeepFilterNet 深度降噪(缺 exe 回退谱减)→VAD 静音裁剪
  const toggleSDn = _h("input", { type: "checkbox", className: "toggle toggle-sm toggle-warning" });
  toggleSDn.checked = _sttGet("serverDenoise") !== "false";
  toggleSDn.addEventListener("change", () => { setSttServerDenoise(toggleSDn.checked).catch(e => window._beiluToast?.("桌宠侧保存失败(需 beilu 运行): " + e.message, "warning")); });
  wrap.appendChild(_settingRow("降噪+拾音（服务端）", "转录前:弱拾音增益补偿 + DeepFilterNet 深度降噪 + VAD 静音裁剪——游戏/嘈杂环境建议开", toggleSDn));

  // 2.6 录音方式（20260722 取证:浏览器默认虚拟麦(NVIDIA Broadcast/Voicemeeter)采到静音,
  //     后端=stt 服务 sounddevice 直采指定设备,绕开浏览器音频栈）
  const selRecMode = _h("select", { className: "select select-sm select-bordered" });
  for (const [v, l] of [["backend", "后端（系统麦直采，推荐）"], ["browser", "浏览器录音"]]) {
    const opt = _h("option", { value: v }, l);
    selRecMode.appendChild(opt);
  }
  selRecMode.value = _sttGet("backendRecord") !== "false" ? "backend" : "browser";
  selRecMode.addEventListener("change", () => _sttSet("backendRecord", selRecMode.value === "backend"));
  wrap.appendChild(_settingRow("录音方式", "后端=STT服务直采声卡设备（不经浏览器）；浏览器=MediaRecorder", selRecMode));

  // 2.7 录音设备 + 找活麦（后端方式用;探测各设备环境底噪,活的物理麦有底噪,死虚拟口≈0）
  const devWrap = _h("div", { style: { display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" } });
  const selDev = _h("select", { className: "select select-sm select-bordered" });
  selDev.style.maxWidth = "260px";
  const _fillDevices = (devices, keep) => {
    selDev.innerHTML = "";
    selDev.appendChild(_h("option", { value: "" }, "系统默认输入"));
    for (const d of devices) {
      const label = `[${d.id}] ${d.name}` + (d.default ? " (默认)" : "") + (d.rms != null ? ` · rms=${d.rms}` : "");
      selDev.appendChild(_h("option", { value: String(d.id) }, label));
    }
    selDev.value = keep ?? _sttGet("recordDevice");
    if (selDev.selectedIndex < 0) selDev.value = "";
  };
  _fillDevices([]);
  selDev.addEventListener("change", () => { setSttRecordDevice(selDev.value).catch(e => window._beiluToast?.("桌宠侧保存失败(需 beilu 运行): " + e.message, "warning")); });
  const _port = () => encodeURIComponent(_sttGet("port"));
  const btnDevRefresh = _h("button", {
    className: "btn btn-xs btn-outline",
    onClick: async () => {
      try {
        const r = await fetch(`/api/parts/plugins:beilu-stt/record/devices?port=${_port()}`);
        if (!r.ok) throw new Error("HTTP " + r.status);
        const j = await r.json();
        _fillDevices(j.devices || []);
        window._beiluToast?.(`已列出 ${j.devices?.length ?? 0} 个输入设备`, "info");
      } catch (e) {
        window._beiluToast?.("获取设备失败（STT 服务需运行中）: " + e.message, "error");
      }
    },
  }, "刷新设备");
  const btnProbe = _h("button", {
    className: "btn btn-xs btn-outline",
    onClick: async () => {
      window._beiluToast?.("正在逐设备探测电平（每台约1.2s，请稍候）...", "info");
      try {
        const r = await fetch(`/api/parts/plugins:beilu-stt/record/probe?port=${_port()}`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
        });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const j = await r.json();
        const results = (j.results || []).map((x) => ({ id: x.device, name: x.name, rms: x.rms }));
        _fillDevices(results, results.length ? String(results[0].id) : "");
        if (results.length) {
          setSttRecordDevice(String(results[0].id)).catch(e => window._beiluToast?.("桌宠侧保存失败(需 beilu 运行): " + e.message, "warning"));
          window._beiluToast?.(`已选电平最高的设备: [${results[0].id}] ${results[0].name} (rms=${results[0].rms})`, "success");
        } else {
          window._beiluToast?.("没有探测到有信号的输入设备", "warning");
        }
      } catch (e) {
        window._beiluToast?.("电平探测失败（STT 服务需运行中）: " + e.message, "error");
      }
    },
  }, "找活麦");
  devWrap.appendChild(selDev); devWrap.appendChild(btnDevRefresh); devWrap.appendChild(btnProbe);
  wrap.appendChild(_settingRow("录音设备", "后端录音用的输入设备；「找活麦」逐台探测底噪并自动选电平最高的", devWrap));

  // 3. 说话人标签
  const toggleSp = _h("input", { type: "checkbox", className: "toggle toggle-sm toggle-warning" });
  toggleSp.checked = _sttGet("showSpeakers") === "true";
  toggleSp.addEventListener("change", () => _sttSet("showSpeakers", toggleSp.checked));
  wrap.appendChild(_settingRow("显示说话人标签", "在转录结果中标注 [S01]、[S02] 等说话人编号", toggleSp));

  // 4. 转录语言
  const select = _h("select", { className: "select select-sm select-bordered" });
  select.style.minWidth = "150px";
  const curLang = _sttGet("language");
  for (const lang of STT_LANGUAGES) {
    const opt = _h("option", { value: lang.value }, lang.label);
    if (lang.value === curLang) opt.selected = true;
    select.appendChild(opt);
  }
  select.addEventListener("change", () => _sttSet("language", select.value));
  wrap.appendChild(_settingRow("转录语言", "语言提示——模型自动识别语种，此项以提示词方式引导，非硬性限制", select));

  // ── 高级设置 ──
  wrap.appendChild(_h("h3", { className: "ext-subsection-title" }, "高级设置"));

  // 5. Python 路径
  const inputPython = _h("input", {
    type: "text", className: "input input-sm input-bordered w-full",
    style: { marginTop: "6px" },
  });
  inputPython.value = _sttGet("pythonExe");
  inputPython.addEventListener("change", () => _sttSet("pythonExe", inputPython.value.trim()));
  wrap.appendChild(_settingBlock("Python 路径", "python 命令名（PATH 上）或解释器完整路径（需安装 torch + transformers）", inputPython));

  // 6. 模型路径
  const inputPath = _h("input", {
    type: "text", className: "input input-sm input-bordered w-full",
    style: { marginTop: "6px" },
    placeholder: "留空 = 默认 moxin/MOSS-Transcribe-Diarize（仓库内）",
  });
  inputPath.value = _sttGet("modelPath");
  inputPath.addEventListener("change", () => _sttSet("modelPath", inputPath.value.trim()));
  wrap.appendChild(_settingBlock("模型路径", "MOSS-Transcribe-Diarize 模型文件夹；留空使用仓库 moxin 默认目录", inputPath));

  // 6. 服务端口
  const inputPort = _h("input", {
    type: "number", className: "input input-sm input-bordered",
    style: { width: "120px" }, min: "1024", max: "65535",
  });
  inputPort.value = _sttGet("port");
  inputPort.addEventListener("change", () => {
    const v = parseInt(inputPort.value, 10);
    if (v >= 1024 && v <= 65535) _sttSet("port", v);
  });
  wrap.appendChild(_settingRow("服务端口", "STT 服务的 HTTP 监听端口", inputPort));

  // 7. 最大 Token 数
  const tokenVal = _h("span", { style: { fontSize: "12px", fontFamily: "monospace", opacity: "0.6", minWidth: "50px", textAlign: "right" } });
  const curTokens = parseInt(_sttGet("maxTokens"), 10) || 8192;
  tokenVal.textContent = String(curTokens);
  const rangeWrap = _h("div", { style: { display: "flex", alignItems: "center", gap: "10px" } });
  const range = _h("input", {
    type: "range", className: "range range-xs range-warning",
    style: { width: "180px" },
    min: "1024", max: "65536", step: "1024",
  });
  range.value = String(curTokens);
  range.addEventListener("input", () => {
    tokenVal.textContent = range.value;
    _sttSet("maxTokens", range.value);
  });
  rangeWrap.appendChild(range);
  rangeWrap.appendChild(tokenVal);
  wrap.appendChild(_settingRow("最大 Token 数", "单次转录的最大生成长度（长音频需调大）", rangeWrap));

  // 8. 热词
  const textarea = _h("textarea", {
    className: "textarea textarea-bordered w-full",
    style: { marginTop: "6px", minHeight: "60px", fontSize: "13px" },
    placeholder: "输入热词，逗号分隔（如：beilu, 凛倾, MOSS）",
  });
  textarea.value = _sttGet("hotwords");
  textarea.addEventListener("change", () => _sttSet("hotwords", textarea.value));
  wrap.appendChild(_settingBlock("热词提示", "提供专有名词/术语帮助模型更准确地转录", textarea));

  // ── 模型信息 ──
  wrap.appendChild(_h("h3", { className: "ext-subsection-title" }, "模型信息"));
  const infoGrid = _h("div", { style: {
    display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px",
    fontSize: "12px", opacity: "0.6",
  } });
  const infos = [
    ["模型", "MOSS-Transcribe-Diarize"],
    ["参数量", "0.9B"],
    ["权重大小", "1.7 GB (bfloat16)"],
    ["架构", "Whisper-Medium + Qwen3-0.6B"],
    ["最大音频时长", "~90 分钟"],
    ["支持语言", "50+"],
    ["说话人分离", "端到端 (无需额外模型)"],
    ["许可证", "Apache 2.0"],
  ];
  for (const [k, v] of infos) {
    infoGrid.appendChild(_h("span", { style: { fontWeight: "500" } }, k));
    infoGrid.appendChild(_h("span", null, v));
  }
  wrap.appendChild(infoGrid);

  container.appendChild(wrap);

  // 初始检查服务状态
  _checkSttStatus(statusDot, statusText);
}

// ============================================================
// STT 服务控制
// ============================================================

let _sttStartPollTimer = null;
// 代际令牌:tick 在途(await 中)时 clearTimeout 清不掉它,靠代际失配让迟到的 tick 自弃,
// 防「停止服务后被在途 tick 覆盖成启动失败」「双入口两条轮询链并行」
let _sttStartPollGen = 0;

function _sttFinishStartUi(ui) {
  if (!ui) return;
  if (ui.btnStart) ui.btnStart.disabled = false;
  if (ui.startRow) ui.startRow.style.display = "none";
}

// 启动进度轮询:消费后端 /status.startup(阶段单源),就绪/失败/超时终止。
// 阶段=启动进程→(装依赖)→初始化→加载模型权重(有分片百分比就显示)→绑定端口→就绪。
function _pollSttStartup(dot, text, ui) {
  clearTimeout(_sttStartPollTimer);
  const gen = ++_sttStartPollGen;
  const t0 = Date.now();
  const tick = async () => {
    if (gen !== _sttStartPollGen) return;
    let data = null;
    try {
      const resp = await fetch(`/api/parts/plugins:beilu-stt/status?port=${encodeURIComponent(_sttGet("port"))}`);
      data = await resp.json();
    } catch { /* 后端瞬断:下轮再试 */ }
    if (gen !== _sttStartPollGen) return; // await 期间被新一轮/停止替代:迟到结果不落 UI
    if (data) {
      const su = data.startup;
      if (data.running && data.model_loaded) {
        dot.className = "ext-status-dot running";
        text.textContent = `运行中 (PID: ${data.pid}, 模型已加载)`;
        _sttFinishStartUi(ui);
        window._beiluToast?.(`STT 服务已就绪（用时 ${su?.elapsedS ?? "?"}s）`, "success");
        return;
      }
      if (su?.phase === "failed" || !data.running) {
        dot.className = "ext-status-dot stopped";
        text.textContent = ("启动失败: " + (su?.error || data.load_error || data.last_error || "进程已退出")).slice(0, 400);
        _sttFinishStartUi(ui);
        window._beiluToast?.("STT 服务启动失败,详情见服务状态卡", "error");
        return;
      }
      const label = su?.label || "等待服务响应";
      const pctStr = su?.pct != null ? ` ${su.pct}%` : "";
      const elapsed = su?.elapsedS ?? Math.round((Date.now() - t0) / 1000);
      dot.className = "ext-status-dot starting";
      text.textContent = `启动中 · ${label}${pctStr} · 已用 ${elapsed}s`;
      if (ui?.startRow) {
        ui.startRow.style.display = "flex";
        if (su?.pct != null) { ui.startProg.max = 100; ui.startProg.value = su.pct; }
        else ui.startProg.removeAttribute("value"); // 无百分比阶段=不确定进度,流动动画
        ui.startText.textContent = `${label}${pctStr} · 已用 ${elapsed}s`;
      }
    }
    if (Date.now() - t0 > 6 * 60_000) {
      _sttFinishStartUi(ui);
      dot.className = "ext-status-dot stopped";
      text.textContent = "启动超时(6 分钟)——点「测试连接」复查,或看后端日志";
      return;
    }
    _sttStartPollTimer = setTimeout(tick, 2000);
  };
  tick();
}

async function _sttServiceAction(action, dot, text, ui) {
  const port = _sttGet("port");
  try {
    if (action === "start") {
      if (ui?.btnStart) ui.btnStart.disabled = true;
      dot.className = "ext-status-dot starting";
      text.textContent = "正在启动...";
      const resp = await fetch("/api/parts/plugins:beilu-stt/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelPath: _sttGet("modelPath"), port: Number(port), pythonExe: _sttGet("pythonExe") }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || data.error) {
        // 旧版此处不查 error,失败也弹"启动中"(模型未装时误导);错误直接可见
        dot.className = "ext-status-dot stopped";
        text.textContent = "启动失败: " + (data.error || "HTTP " + resp.status);
        _sttFinishStartUi(ui);
        window._beiluToast?.("启动失败: " + (data.error || "HTTP " + resp.status), "error");
        return;
      }
      if (data.status === "already_running" && (!data.startup || data.startup.phase === "ready")) {
        window._beiluToast?.("服务已在运行中", "info");
        _sttFinishStartUi(ui);
        _checkSttStatus(dot, text);
        return;
      }
      // 新拉起 或 已在运行但模型仍在加载:统一进入进度轮询
      if (data.status !== "already_running")
        window._beiluToast?.("服务启动中,首次加载模型约需 1-2 分钟", "info");
      _pollSttStartup(dot, text, ui);
    } else if (action === "stop") {
      clearTimeout(_sttStartPollTimer);
      _sttStartPollGen++; // 作废在途 tick,防迟到结果把"已停止"覆盖成"启动失败"
      _sttFinishStartUi(ui);
      const resp = await fetch("/api/parts/plugins:beilu-stt/stop", { method: "POST" });
      const data = await resp.json();
      dot.className = "ext-status-dot stopped";
      text.textContent = "服务已停止";
      window._beiluToast?.("STT 服务已停止", "info");
    } else if (action === "test") {
      dot.className = "ext-status-dot starting";
      text.textContent = "测试中...";
      await _checkSttStatus(dot, text);
    }
  } catch (err) {
    _sttFinishStartUi(ui);
    dot.className = "ext-status-dot stopped";
    text.textContent = "操作失败: " + err.message;
    window._beiluToast?.("服务操作失败: " + err.message, "error");
  }
}

async function _checkSttStatus(dot, text) {
  try {
    // status 的后端 health 探测按 query port 打（main.mjs 读 req.query.port||7861），
    // 不带参会在用户自定义端口时永远探错端口 → 假"模型加载中"
    const resp = await fetch(`/api/parts/plugins:beilu-stt/status?port=${encodeURIComponent(_sttGet("port"))}`);
    const data = await resp.json();
    if (data.running) {
      if (data.model_loaded) {
        dot.className = "ext-status-dot running";
        text.textContent = `运行中 (PID: ${data.pid}, 模型已加载)`;
      } else if (data.startup?.phase === "failed" || data.load_error) {
        dot.className = "ext-status-dot stopped";
        text.textContent = ("模型加载失败: " + (data.load_error || data.startup?.error || "")).slice(0, 400);
      } else {
        dot.className = "ext-status-dot starting";
        text.textContent = `进程运行中 (PID: ${data.pid})，${data.health_error || "模型加载中..."}`;
        // 启动中:接上进度轮询,面板打开就能看到实时阶段(自动连接拉起的服务同样覆盖)
        if (data.startup) _pollSttStartup(dot, text, null);
      }
    } else {
      dot.className = "ext-status-dot stopped";
      text.textContent = "服务未运行";
    }
  } catch {
    dot.className = "ext-status-dot stopped";
    text.textContent = "无法连接后端";
  }
}

// ============================================================
// Reach 插件 — 平台触达
// ============================================================

const REACH_KEYS = {
  enabled:            "beilu-reach-enabled",
  platformRoute:      "beilu-reach-platform-route",
  urlSmartExtract:    "beilu-reach-url-smart-extract",
  cliTimeout:         "beilu-reach-cli-timeout",
  proxyUrl:           "beilu-reach-proxy-url",
  allowedPlatforms:   "beilu-reach-allowed-platforms",
  // 平台凭据
  twitterAuthToken:   "beilu-reach-twitter-auth-token",
  twitterCt0:         "beilu-reach-twitter-ct0",
  githubToken:        "beilu-reach-github-token",
  xueqiuCookie:       "beilu-reach-xueqiu-cookie",
  xhsCookie:          "beilu-reach-xhs-cookie",
  biliSessdata:       "beilu-reach-bili-sessdata",
  biliCsrf:           "beilu-reach-bili-csrf",
  ytCookiesFrom:      "beilu-reach-yt-cookies-from",
};

// 默认值单源=后端（GetData.defaults），前端零副本（凛倾 0722 禁前端硬编码）。
// 面板打开时从 getdata 填充；未加载前 _reachGet 回退 undefined（渲染均在加载后发生）。
let _reachDefaults = {};

function _reachGet(key) {
  const v = storage.get(REACH_KEYS[key]);
  return (v !== null && v !== undefined && v !== "") ? v : _reachDefaults[key];
}

function _reachSet(key, value) {
  storage.set(REACH_KEYS[key], String(value));
  _reachSyncBackend();
}

async function _reachSyncBackend() {
  try {
    const payload = {};
    for (const [k] of Object.entries(REACH_KEYS)) payload[k] = _reachGet(k);
    await fetch("/api/parts/plugins:beilu-reach/config/setdata", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {}
}

/** 凭据「如何获取」折叠引导（原生 details，零 JS 状态） */
function _helpDetails(bodyText) {
  return _h("details", { className: "ext-help-details" },
    _h("summary", null, "如何获取？"),
    _h("div", { className: "ext-help-body" }, bodyText),
  );
}

/** reach 使用引导卡（范式同 STT 引导卡）：怎么用 / 工具 / Cookie 是什么 */
function _renderReachGuide() {
  const card = _h("div", { className: "ext-status-card" });
  card.appendChild(_h("div", { className: "ext-guide-title" }, "使用引导"));
  const rows = [
    ["① 怎么用", "对话里直接提需求即可，比如「看看 V2EX 上有什么热帖」「搜一下 GitHub 上的开源 PPT 工具」——AI 会自动调用对应平台获取结构化数据。"],
    ["② 平台工具", "部分平台依赖命令行工具（gh / yt-dlp / opencli 等）。下方「平台状态」卡实时显示每个平台是否就绪：✓ 可用，✗ 工具未安装。零配置平台无需任何准备。"],
    ["③ Cookie 是什么", "Cookie 是网站保存在你浏览器里的登录凭证。部分平台（Twitter/B站/小红书/雪球）需要它才能以你的身份读取数据。复制方法见各平台下方的「如何获取？」。凭据只存在本机、只用于请求对应平台，不会出现在 AI 对话里。"],
  ];
  for (const [step, text] of rows) {
    card.appendChild(_h("div", { className: "ext-guide-row" },
      _h("span", { className: "ext-guide-step" }, step),
      _h("span", { className: "ext-guide-text" }, text),
    ));
  }
  return card;
}

function renderReachPlugin(container) {
  const wrap = _h("div", { className: "ext-wrap" });

  wrap.appendChild(_h("div", { className: "ext-title-area" },
    _h("h2", { className: "ext-section-title" }, "平台触达 (Reach)"),
    _h("p", { className: "ext-section-desc" },
      "13 个互联网平台结构化数据获取 · AI 通过 <reach> 标签调用 · 搜索管线自动路由"),
  ));

  wrap.appendChild(_renderReachGuide());

  const statusCard = _h("div", { className: "ext-status-card" });
  const statusGrid = _h("div", null);
  statusGrid.textContent = "正在检测平台工具...";
  statusCard.appendChild(statusGrid);
  statusCard.appendChild(_h("div", { className: "ext-btn-group" },
    _h("button", { className: "btn btn-sm btn-outline", onClick: () => _reachDoctor(statusGrid) }, "刷新诊断"),
  ));
  wrap.appendChild(statusCard);

  // 设置区整体 schema 驱动（凛倾 0722 禁前端硬编码）：控件/限值/默认值/凭据声明/帮助文案
  // 全部来自后端 getdata（meta+defaults+platforms.credentials），前端纯渲染。
  const settingsHost = _h("div", null);
  wrap.appendChild(settingsHost);
  container.appendChild(wrap);

  async function load() {
    settingsHost.innerHTML = "";
    let data = null;
    try {
      const r = await fetch("/api/parts/plugins:beilu-reach/config/getdata");
      if (!r.ok) throw new Error(String(r.status));
      data = await r.json();
    } catch {
      settingsHost.appendChild(_schemaUnavailableCard(load));
      statusGrid.textContent = "等待后端加载...";
      return;
    }
    _reachDefaults = data.defaults || {};
    _renderMetaGroups(settingsHost, data.meta || [], _reachGet, _reachSet);

    const platforms = data.platforms || {};
    const zeroConf = Object.values(platforms)
      .filter((p) => p.tier === 0 && !(p.credentials || []).length)
      .map((p) => p.label);
    if (zeroConf.length) {
      settingsHost.appendChild(_h("h3", { className: "ext-subsection-title" }, "零配置平台"));
      settingsHost.appendChild(_h("p", { className: "ext-section-desc" }, zeroConf.join(" · ") + " 无需任何凭据即可使用"));
    }
    for (const p of Object.values(platforms)) {
      const creds = p.credentials || [];
      if (!creds.length) continue;
      settingsHost.appendChild(_h("h3", { className: "ext-subsection-title" }, p.label));
      for (const c of creds) settingsHost.appendChild(_renderMetaControl(c, _reachGet, _reachSet));
      if (p.credentialHelp) settingsHost.appendChild(_helpDetails(p.credentialHelp));
    }

    _renderReachStatus(statusGrid, platforms);
    // defaults 已就位后回灌：后端重启后配置从落盘读回，此处再推一遍 localStorage 权威值
    _reachSyncBackend();
  }
  load();
}

/** 平台状态渲染（doctor 报告 → 状态行；getdata 初载与刷新诊断共用） */
function _renderReachStatus(grid, report) {
  grid.innerHTML = "";
  const statusIcon = { ok: "✓", missing: "✗", blocked: "⚠", error: "✗" };
  for (const [name, info] of Object.entries(report || {})) {
    const s = info.status || "missing";
    grid.appendChild(_h("div", { className: "ext-doctor-row" },
      _h("span", { className: `ext-doctor-icon ${s}` }, statusIcon[s] || "?"),
      _h("span", { className: "ext-doctor-name" }, info.label || name),
      _h("span", { className: "ext-doctor-detail" },
        s === "ok"
          ? `${info.backend || "native"}${info.version ? " " + info.version : ""} · ${(info.actions || []).join("/")}`
          : (info.message || s)),
    ));
  }
}

async function _reachDoctor(grid) {
  grid.textContent = "正在检测...";
  try {
    const resp = await fetch("/api/parts/plugins:beilu-reach/config/setdata", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ _action: "doctor" }),
    });
    _renderReachStatus(grid, await resp.json());
  } catch (err) {
    grid.textContent = "检测失败: " + err.message;
  }
}

// ============================================================
// Browser 插件 — 浏览器自动化
// ============================================================

const BROWSER_KEYS = {
  enabled:          "beilu-browser-enabled",
  port:             "beilu-browser-port",
  snapshotMaxLines: "beilu-browser-snapshot-max-lines",
  chromePath:       "beilu-browser-chrome-path",
  userDataDir:      "beilu-browser-user-data-dir",
  driverPath:       "beilu-browser-driver-path",
  defaultTimeout:   "beilu-browser-default-timeout",
  defaultScrollDy:  "beilu-browser-default-scroll-dy",
  gotoWaitUntil:    "beilu-browser-goto-wait-until",
  resultLabel:      "beilu-browser-result-label",
  resultSeparator:  "beilu-browser-result-separator",
  autoReconnect:    "beilu-browser-auto-reconnect",
  recordBrowsing:   "beilu-browser-record-browsing",
  historyFile:      "beilu-browser-history-file",
  historyMaxRead:   "beilu-browser-history-max-read",
};

// 默认值/类型单源=后端（GetData.defaults/meta），前端零副本（凛倾 0722 禁前端硬编码）。
let _browserDefaults = {};
let _browserMeta = [];

function _browserGet(key) {
  const v = storage.get(BROWSER_KEYS[key]);
  return (v !== null && v !== undefined && v !== "") ? v : _browserDefaults[key];
}

function _browserSet(key, value) {
  storage.set(BROWSER_KEYS[key], String(value));
  _browserSyncBackend();
}

async function _browserSyncBackend() {
  try {
    // 类型转换按后端 meta.type 判定（原前端硬编码布尔/整数键名单=类型信息双源）
    const _typeOf = (k) => _browserMeta.find((m) => m.key === k)?.type || "text";
    const payload = {};
    for (const [k] of Object.entries(BROWSER_KEYS)) {
      const v = _browserGet(k);
      if (v === undefined) continue; // defaults 未加载的键跳过（后端 merge 忽略缺键）
      const t = _typeOf(k);
      if (t === "toggle") payload[k] = String(v) === "true" || v === true;
      else if (t === "number" || t === "range") payload[k] = parseInt(v, 10);
      else payload[k] = v;
    }
    // 路径修正：原 /config 后端无此路由恒 404（Load 未注册），现对齐插件 config REST 范式 /config/setdata
    await fetch("/api/parts/plugins:beilu-browser/config/setdata", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {}
}

/** browser 使用引导卡（范式同 STT/reach 引导卡）：三步状态 + 重新检测 */
function _renderBrowserGuide() {
  const card = _h("div", { className: "ext-status-card" });
  card.appendChild(_h("div", { className: "ext-guide-title" }, "使用引导"));

  const mkStep = (title) => {
    const dot = _h("span", { className: "ext-status-dot stopped" });
    const text = _h("span", { className: "ext-guide-text" }, "检测中...");
    const row = _h("div", { className: "ext-guide-row" },
      dot, _h("span", { className: "ext-guide-step" }, title), text);
    return { row, dot, text };
  };
  const stepChrome = mkStep("① Chrome");
  const stepDriver = mkStep("② 插件连接");
  const stepUse = mkStep("③ 开始使用");
  for (const s of [stepChrome, stepDriver, stepUse]) card.appendChild(s.row);

  const _set = (s, state, msg) => {
    s.dot.className = "ext-status-dot " + state; // running / starting / stopped
    s.text.textContent = msg;
  };

  async function refresh() {
    try {
      const r = await fetch(`/api/parts/shells:chat/plugins/beilu-browser/status?port=${_browserGet("port")}`);
      const j = await r.json();
      _set(stepChrome, j.connected ? "running" : "stopped",
        j.connected ? `调试模式运行中（${j.browser || "Chrome"}）`
                    : "未以调试模式运行——点下方「服务状态」卡的「启动 Chrome」（会用独立用户目录，不影响你日常的浏览器窗口）");
    } catch {
      _set(stepChrome, "stopped", "检测失败——后端不可用");
    }
    try {
      const r = await fetch("/api/parts/plugins:beilu-browser/config/getdata");
      if (r.status === 404) { _set(stepDriver, "starting", "连接状态端点未生效——重启 beilu 后可用"); }
      else {
        const j = await r.json();
        _set(stepDriver, j.connected ? "running" : "starting",
          j.connected ? "驱动已连接浏览器" : "尚未连接——AI 首次执行浏览器操作时自动连接，无需手动");
      }
    } catch { _set(stepDriver, "starting", "连接状态获取失败"); }
    _set(stepUse, "starting", "对话里直接提需求即可，比如「打开某个网站帮我查…」「同步到我正在看的页面继续操作」——AI 会自动使用浏览器。");
    stepUse.dot.className = "ext-status-dot running";
  }

  const btnRefresh = _h("button", { className: "btn btn-xs btn-outline", onClick: refresh }, "重新检测");
  card.appendChild(btnRefresh);
  refresh();
  return card;
}

/** browser 控制区：手动同步到用户标签页 + 浏览记录查看/清空 */
function _renderBrowserControl() {
  const card = _h("div", { className: "ext-status-card" });
  card.appendChild(_h("div", { className: "ext-guide-title" }, "浏览与记录"));

  const histList = _h("div", { className: "ext-hist-list" });
  histList.textContent = "加载中...";

  async function loadHistory() {
    try {
      const r = await fetch("/api/parts/plugins:beilu-browser/config/getdata");
      if (r.status === 404) { histList.textContent = "浏览记录端点未生效——重启 beilu 后可用"; return; }
      const j = await r.json();
      const items = j.recentHistory || [];
      histList.innerHTML = "";
      if (items.length === 0) { histList.textContent = "暂无浏览记录（AI 执行浏览器操作后自动记录）"; return; }
      for (const e of items.slice().reverse()) {
        histList.appendChild(_h("div", { className: "ext-hist-item" },
          _h("span", { className: "ext-hist-time" }, (e.ts || "").replace("T", " ").slice(5, 19)),
          _h("span", { className: "ext-hist-op" }, e.op || ""),
          _h("span", null, `${e.title || ""} ${e.url || ""}`.trim()),
        ));
      }
    } catch (err) { histList.textContent = "浏览记录加载失败: " + err.message; }
  }

  const btnSync = _h("button", {
    className: "btn btn-sm btn-outline",
    onClick: async () => {
      try {
        const r = await fetch("/api/parts/plugins:beilu-browser/control/sync", { method: "POST" });
        const j = await r.json();
        if (j.ok) window._beiluToast?.(`已同步到：${j.tab?.title || j.tab?.url || "当前标签页"}`, "info");
        else window._beiluToast?.("同步失败: " + (j.error || "未知错误"), "error");
      } catch (e) { window._beiluToast?.("同步失败: " + e.message, "error"); }
    },
  }, "同步到我的标签页");
  const btnHistRefresh = _h("button", { className: "btn btn-sm btn-outline", onClick: loadHistory }, "刷新记录");
  const btnHistClear = _h("button", {
    className: "btn btn-sm btn-outline",
    onClick: async () => {
      try {
        const r = await fetch("/api/parts/plugins:beilu-browser/control/clear-history", { method: "POST" });
        const j = await r.json();
        if (j.ok) { window._beiluToast?.("浏览记录已清空", "info"); loadHistory(); }
        else window._beiluToast?.("清空失败: " + (j.error || ""), "error");
      } catch (e) { window._beiluToast?.("清空失败: " + e.message, "error"); }
    },
  }, "清空记录");

  card.appendChild(_h("div", { className: "ext-btn-group" }, btnSync, btnHistRefresh, btnHistClear));
  card.appendChild(histList);
  loadHistory();
  return card;
}

function renderBrowserPlugin(container) {
  // 内联样式清除（凛倾 0722 禁前端硬编码）：全部复用 reach 面板同款 ext-* 类，样式单源 work-panels.css
  const wrap = _h("div", { className: "ext-wrap" });

  wrap.appendChild(_h("div", { className: "ext-title-area" },
    _h("h2", { className: "ext-section-title" }, "浏览器自动化"),
    _h("p", { className: "ext-section-desc" },
      "通过 Chrome DevTools Protocol (CDP) 控制真实浏览器 · 导航/点击/输入/快照/截图 · AI 自主操作"),
  ));

  wrap.appendChild(_renderBrowserGuide());

  // ── 连接状态卡片 ──
  const statusCard = _h("div", { className: "ext-status-card" });
  const statusDot = _h("span", { className: "ext-status-dot stopped" });
  const statusText = _h("span", { className: "ext-status-text" }, "检测中...");
  statusCard.appendChild(_h("div", { className: "ext-status-row" }, statusDot, statusText));

  const btnTest = _h("button", {
    className: "btn btn-sm btn-outline",
    onClick: () => _browserCheckStatus(statusDot, statusText),
  }, "测试连接");
  const btnLaunch = _h("button", {
    className: "btn btn-sm btn-outline",
    onClick: () => _browserLaunchChrome(statusDot, statusText),
  }, "启动 Chrome");
  statusCard.appendChild(_h("div", { className: "ext-btn-group" }, btnTest, btnLaunch));
  wrap.appendChild(statusCard);

  wrap.appendChild(_renderBrowserControl());

  // 设置区整体 schema 驱动（凛倾 0722 禁前端硬编码）：控件/限值/默认值/选项/操作表
  // 全部来自后端 getdata（meta+defaults+ops），前端纯渲染。
  const settingsHost = _h("div", null);
  wrap.appendChild(settingsHost);

  async function load() {
    settingsHost.innerHTML = "";
    let data = null;
    try {
      const r = await fetch("/api/parts/plugins:beilu-browser/config/getdata");
      if (!r.ok) throw new Error(String(r.status));
      data = await r.json();
    } catch {
      settingsHost.appendChild(_schemaUnavailableCard(load));
      return;
    }
    _browserDefaults = data.defaults || {};
    _browserMeta = data.meta || [];
    _renderMetaGroups(settingsHost, _browserMeta, _browserGet, _browserSet);

    settingsHost.appendChild(_h("h3", { className: "ext-subsection-title" }, "支持的操作"));
    const infoGrid = _h("div", { className: "ext-info-grid" });
    for (const op of data.ops || []) {
      infoGrid.appendChild(_h("span", { className: "info-name" }, op.name));
      infoGrid.appendChild(_h("span", null, op.desc));
    }
    settingsHost.appendChild(infoGrid);

    settingsHost.appendChild(_h("h3", { className: "ext-subsection-title" }, "可用宏"));
    const macroGrid = _h("div", { className: "ext-info-grid" });
    for (const m of data.macros || []) {
      macroGrid.appendChild(_h("span", { className: "info-name" }, m.name));
      macroGrid.appendChild(_h("span", null, m.desc));
    }
    settingsHost.appendChild(macroGrid);

    // defaults 已就位后回灌 + 刷新状态显示（此前 port 等取不到默认值）
    _browserSyncBackend();
    _browserCheckStatus(statusDot, statusText);
  }
  load();
  container.appendChild(wrap);
}

async function _browserCheckStatus(dot, text) {
  try {
    const resp = await fetch("/api/parts/shells:chat/plugins/beilu-browser/status");
    const data = await resp.json();
    if (data.connected) {
      dot.className = "ext-status-dot running";
      text.textContent = `已连接 (${data.browser || "Chrome"})`;
    } else {
      dot.className = "ext-status-dot stopped";
      text.textContent = `未连接 (端口 ${_browserGet("port")})`;
    }
  } catch {
    dot.className = "ext-status-dot stopped";
    text.textContent = `后端不可用`;
  }
}

async function _browserLaunchChrome(dot, text) {
  const port = _browserGet("port");
  const userDataDir = _browserGet("userDataDir");
  const chromePath = _browserGet("chromePath");

  dot.className = "ext-status-dot starting";
  text.textContent = "正在启动 Chrome...";

  try {
    const resp = await fetch("/api/parts/shells:chat/plugins/beilu-browser/launch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ port, userDataDir, chromePath }),
    });
    const data = await resp.json();
    if (data.ok) {
      window._beiluToast?.("Chrome 启动成功", "info");
      setTimeout(() => _browserCheckStatus(dot, text), 2000);
    } else {
      dot.className = "ext-status-dot stopped";
      text.textContent = data.error || "启动失败";
      window._beiluToast?.("Chrome 启动失败: " + (data.error || "未知错误"), "error");
    }
  } catch (err) {
    dot.className = "ext-status-dot stopped";
    text.textContent = "请求失败: " + err.message;
    window._beiluToast?.("无法连接后端: " + err.message, "error");
  }
}

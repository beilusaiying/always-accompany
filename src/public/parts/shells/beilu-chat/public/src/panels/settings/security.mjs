/**
 * security.mjs — 安全中心面板 cluster
 *
 * 功能链：打开「安全中心」面板 → _initSecurityCenter()（幂等，仅首次绑定事件）→ 自动调用 _loadSecurityStatus()
 *   → GET /api/security/status 返回各安全检查项（API Key 泄露/CORS/认证/TLS 等）
 *   → 渲染总体评分（通过/警告/严重数量）和分项列表（绿/黄/红圆点 + 提示）
 *   → 各项可带内联控件（select/switch/number/ejs）→ onChange 即时 POST 持久化配置
 *   → 点击「一键检查」生成结构化文本报告展示在 #security-report
 * why：安全配置分散在多个后端模块，UI 只做框架管道展示后端返回的状态，不硬编码任何规则，
 *   控件描述来自后端 add() 第6参 control，前后端解耦
 * 关联链：被 settings.mjs import（在 _initSettingsModals 切到「安全」Tab 时调用）；
 *   import api-client.mjs（/api/security/status）、storage.mjs（控件值持久化）、toast.mjs（错误提示）
 * 影响范围：改动影响安全中心面板的渲染逻辑、控件类型支持、报告格式
 * 使用效果：用户打开「安全中心」看到各项安全状态评分，点「一键检查」生成详细报告，可直接在面板调整安全配置
 */
import { escapeHtml } from "../../shared/state/utils.mjs";
import { sendAction } from "../../shared/transport/sendAction.mjs"; // T6b：出向统一门面（安全控件端点由后端 control 描述符驱动=动态 URL 走 ctrlGet/ctrlPost）
import { storage } from "../../shared/state/storage.mjs";
import { showToast } from "../../../../../../../scripts/toast.mjs";

// ============================================================
// SEC-H: 安全中心面板 — 展示 /api/security/status 采集到的状态
//   UI 只做展示 + 一键检查报告;不强制任何配置(只做框架,不做决定)
// ============================================================
let _securityCenterInited = false;
async function _initSecurityCenter() {
  if (_securityCenterInited) { _loadSecurityStatus(); return; }
  _securityCenterInited = true;
  document.getElementById("security-refresh-btn")?.addEventListener("click", _loadSecurityStatus);
  document.getElementById("security-check-btn")?.addEventListener("click", async () => {
    const btn = document.getElementById("security-check-btn");
    const prev = btn.textContent;
    btn.disabled = true;
    btn.textContent = "检查中...";
    try {
      await _loadSecurityStatus();
      const report = document.getElementById("security-report");
      const items = window.__beiluSecurityItems || [];
      const warnings = items.filter(i => i.level === "warn");
      const errors = items.filter(i => i.level === "error");
      const passes = items.filter(i => i.level === "ok");
      let text = `🛡️ 安全检查 (${new Date().toLocaleString()})\n`;
      text += `总计 ${items.length} 项 · 通过 ${passes.length} · 警告 ${warnings.length} · 严重 ${errors.length}\n\n`;
      if (errors.length) {
        text += `🔴 严重:\n` + errors.map(i => `  · ${i.label}: ${i.status}${i.hint ? "\n    → " + i.hint : ""}`).join("\n") + "\n\n";
      }
      if (warnings.length) {
        text += `🟡 警告:\n` + warnings.map(i => `  · ${i.label}: ${i.status}${i.hint ? "\n    → " + i.hint : ""}`).join("\n") + "\n\n";
      }
      if (passes.length) {
        text += `🟢 通过:\n` + passes.map(i => `  · ${i.label}: ${i.status}`).join("\n") + "\n";
      }
      report.textContent = text;
      report.classList.remove("hidden");
    } catch (e) {
      showToast("error", "检查失败: " + e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = prev;
    }
  });
  _loadSecurityStatus();
}

async function _loadSecurityStatus() {
  const summary = document.getElementById("security-summary");
  const list = document.getElementById("security-items");
  if (!summary || !list) return;
  summary.textContent = "加载中...";
  list.innerHTML = "";
  try {
    // 原 raw GET + r.ok 手检；门面非 raw，!ok 由门面抛错走 catch（原 "加载失败: " 分支等价）
    const data = await sendAction({ verb: "getStatus", target: "server:security", source: "web" });
    if (!data.success) throw new Error(data.error || "unknown error");
    const s = data.summary || {};
    const okRate = s.total > 0 ? Math.round((s.ok / s.total) * 100) : 0;
    summary.innerHTML = `<span class="font-semibold">总体: ${s.ok}/${s.total} 安全 (${okRate}%)</span> · 警告 <span class="text-warning">${s.warn || 0}</span> · 严重 <span class="text-error">${s.error || 0}</span>`;
    window.__beiluSecurityItems = data.items || [];
    list.innerHTML = (data.items || []).map((i) => {
      const dot = _secDot(i.level);
      const hint = i.hint ? `<div class="text-xs text-base-content/50 mt-0.5">${_secIcon("lightbulb")} ${_escHtmlBasic(i.hint)}</div>` : "";
      const ctrlHtml = i.control ? _renderSecCtrl(i) : `<span class="text-xs text-base-content/60">${_escHtmlBasic(i.status)}</span>`;
      // 放宽项风险提示（控件层面，红字）。
      const riskHtml = _secRiskHint(i);
      return `<div class="p-2 bg-base-200 rounded" data-sec-id="${_escHtmlBasic(i.id)}">
        <div class="flex items-center gap-2">
          ${dot}
          <span class="text-xs font-medium flex-1">${_escHtmlBasic(i.label)}</span>
          ${ctrlHtml}
        </div>${hint}${riskHtml}
      </div>`;
    }).join("");
    // DOM 就绪后绑定控件事件 + 回显当前值（localStorage 项即时回显；part config 项异步拉取）。
    _wireSecCtrls(list, data.items || []);
  } catch (e) {
    summary.textContent = "加载失败: " + e.message;
  }
}

// 状态灯：daisyUI 5 status 组件替代 emoji 球（🟢🟡🔴 系统 emoji 渲染成光泽球且跨平台不一致）。
//   error 级叠 animate-ping 呼吸扩散动画（inline grid-area 双层叠放，不依赖 TW 任意变体类）。
function _secDot(level) {
  if (level === "error") {
    return `<span style="display:inline-grid" aria-label="严重"><span class="status status-error status-md animate-ping" style="grid-area:1/1"></span><span class="status status-error status-md" style="grid-area:1/1"></span></span>`;
  }
  if (level === "warn") return `<span class="status status-warning status-md" aria-label="警告"></span>`;
  return `<span class="status status-success status-md" aria-label="通过"></span>`;
}
// 线性图标：走项目自建 data-ic 图标系统（index.css，CSS mask 本地 SVG，纯 CSS 零 JS，innerHTML 即生效）。
//   lightbulb/lock 为本次新增图标（Iconify mdi，与既有 mdi__*.svg 同源同风格）；warning 复用既有。
function _secIcon(name) {
  return `<i data-ic="${name}"></i>`;
}

// SEC-T11：渲染安全中心可配置控件（select/switch/ejs/list；switch 可带 numField 伴随数值输入）。
//   控件描述来自后端 add() 的第6参 control（见 endpoints.mjs /api/security/status）。
function _renderSecCtrl(i) {
  const c = i.control;
  const idv = _escHtmlBasic(i.id);
  if (c.kind === "select") {
    const cur = _secCtrlCurrentValue(i);
    const opts = (c.options || []).map((o) =>
      `<option value="${_escHtmlBasic(o.value)}"${o.value === cur ? " selected" : ""}>${_escHtmlBasic(o.label)}</option>`
    ).join("");
    const dis = c.locked ? " disabled" : "";
    return `<select class="select select-xs select-bordered text-xs" data-sec-ctrl="select" data-sec-id="${idv}"${dis}>${opts}</select>`;
  }
  if (c.kind === "switch") {
    const on = _secCtrlBoolValue(i);
    const sw = `<input type="checkbox" class="toggle toggle-sm toggle-success" data-sec-ctrl="switch" data-sec-id="${idv}"${on ? " checked" : ""}/>`;
    // T11-A：switch 可带伴随数值输入（numField），用于「开关 + 阈值」型配置（如 gen_concurrency 的 max）。
    //   后端 add() control 附 numField/numValue/numMin/numLabel 即启用；改动 POST { [numField]: value }。
    if (c.numField) {
      const numDis = c.locked ? " disabled" : "";
      const numMin = Number.isFinite(c.numMin) ? ` min="${c.numMin}"` : "";
      const numLbl = c.numLabel ? _escHtmlBasic(c.numLabel) : "";
      return `<span class="flex items-center gap-2 text-xs">${sw}<span>${numLbl}</span>`
        + `<input type="number"${numMin} step="1" value="${_escHtmlBasic(String(c.numValue ?? ""))}" class="input input-xs input-bordered w-20 font-mono" data-sec-ctrl="switch-num" data-sec-id="${idv}"${numDis}/></span>`;
    }
    return sw;
  }
  if (c.kind === "ejs") {
    // 超时数字输入 + opt-out 开关；初值异步从 part config 拉取后回填。
    return `<span class="flex items-center gap-1 text-xs">
      超时<input type="number" min="100" step="100" value="3000" class="input input-xs input-bordered w-20" data-sec-ctrl="ejs-timeout" data-sec-id="${idv}"/>ms
      <span class="ml-1">opt-out</span><input type="checkbox" class="toggle toggle-sm toggle-error" data-sec-ctrl="ejs-optout" data-sec-id="${idv}"/>
    </span>`;
  }
  if (c.kind === "list") {
    const vals = Array.isArray(c.value) ? c.value : [];
    const tags = vals.map((v) =>
      `<span class="badge badge-sm badge-outline gap-1" data-sec-list-val="${_escHtmlBasic(v)}">${_escHtmlBasic(v)}<button class="btn btn-ghost btn-xs px-0" data-sec-list-rm="${_escHtmlBasic(v)}">✕</button></span>`
    ).join("");
    return `<div class="w-full mt-1" data-sec-ctrl="list" data-sec-id="${idv}">
      <div class="flex flex-wrap gap-1 mb-1">${tags || '<span class="text-xs text-base-content/40">（空）</span>'}</div>
      <div class="flex gap-1"><input type="text" class="input input-xs input-bordered flex-1" placeholder="${_escHtmlBasic(c.placeholder || "")}" data-sec-list-input="${idv}"/><button class="btn btn-xs btn-outline btn-success" data-sec-list-add="${idv}">+</button></div>
    </div>`;
  }
  return `<span class="text-xs text-base-content/60">${_escHtmlBasic(i.status)}</span>`;
}

// 风险提示：select 命中风险 option / switch 处于放宽态 / ejs opt-out 开 → 红字。
function _secRiskHint(i) {
  const c = i.control;
  if (!c) return "";
  let risk = "";
  if (c.kind === "select") {
    const cur = _secCtrlCurrentValue(i);
    const opt = (c.options || []).find((o) => o.value === cur);
    if (opt && opt.risk) risk = opt.risk;
    if (c.locked && c.lockedHint) {
      return `<div class="text-xs text-warning mt-0.5">${_secIcon("lock")} ${_escHtmlBasic(c.lockedHint)}</div>`;
    }
  } else if (c.kind === "switch") {
    if (_secCtrlBoolValue(i) && c.risk) risk = c.risk;
  } else if (c.kind === "ejs") {
    // opt-out 风险在异步回填后由 _wireSecCtrls 动态显示
    risk = "";
  }
  return risk ? `<div class="text-xs text-error mt-0.5" data-sec-risk="1">${_secIcon("warning")} ${_escHtmlBasic(risk)}</div>` : "";
}

// 取 select 当前值：localStorage 项读本地；server 项读后端回传的 value。
function _secCtrlCurrentValue(i) {
  const c = i.control;
  if (c.source === "localStorage") {
    try {
      const v = storage.get(c.key);
      return (v !== null && v !== undefined && v !== "") ? v : (c.default || (c.options?.[0]?.value));
    } catch { return c.default || (c.options?.[0]?.value); }
  }
  // server 项：后端已回传当前 config 值
  return c.value;
}

// 取 switch 当前布尔：localStorage 用 truthy 串比较；server 用后端回传 value。
function _secCtrlBoolValue(i) {
  const c = i.control;
  if (c.source === "localStorage") {
    try {
      const v = storage.get(c.key);
      if (v === null) return !!c.default;
      return v === (c.truthy || "true");
    } catch { return !!c.default; }
  }
  return c.value === true;
}

// 绑定所有控件 onChange + 异步项回显。
function _wireSecCtrls(root, items) {
  const byId = {};
  for (const it of items) if (it.control) byId[it.id] = it;

  // select
  root.querySelectorAll('[data-sec-ctrl="select"]').forEach((el) => {
    const it = byId[el.dataset.secId];
    if (!it) return;
    el.addEventListener("change", async () => {
      const c = it.control;
      const val = el.value;
      if (c.source === "localStorage") {
        try { storage.set(c.key, val); } catch {}
        _refreshSecRisk(el, it, val);
      } else {
        el.disabled = true;
        try {
          // 原 raw POST c.endpoint（后端 control 描述符动态 URL）→ 门面 ctrlPost 动态端点路由；门面返回解析体
          const d = await sendAction({ verb: "ctrlPost", target: "server:security", source: "web", payload: { _endpoint: c.endpoint, [c.field]: val } });
          if (!d || d.success === false) throw new Error(d?.error || "保存失败");
          c.value = val;
          _refreshSecRisk(el, it, val);
        } catch (e) {
          showToast("error", "保存失败: " + e.message);
          el.value = c.value; // 回滚显示
        } finally { el.disabled = false; }
      }
    });
  });

  // switch
  root.querySelectorAll('[data-sec-ctrl="switch"]').forEach((el) => {
    const it = byId[el.dataset.secId];
    if (!it) return;
    el.addEventListener("change", async () => {
      const c = it.control;
      const want = el.checked;
      if (c.source === "localStorage") {
        try { storage.set(c.key, want ? (c.truthy || "true") : "false"); } catch {}
        _refreshSecRiskBool(el, it, want);
      } else {
        el.disabled = true;
        try {
          // 原 raw POST c.endpoint（动态 URL）→ 门面 ctrlPost；门面返回解析体（读 d[c.field] 回填）
          const d = await sendAction({ verb: "ctrlPost", target: "server:security", source: "web", payload: { _endpoint: c.endpoint, [c.field]: want } });
          if (!d || d.success === false) throw new Error(d?.error || "保存失败");
          c.value = (d[c.field] !== undefined) ? d[c.field] : want;
          el.checked = c.value === true;
          _refreshSecRiskBool(el, it, c.value === true);
        } catch (e) {
          showToast("error", "保存失败: " + e.message);
          el.checked = !want; // 回滚
        } finally { el.disabled = false; }
      }
    });
  });

  // T11-A：switch 伴随数值输入（如 gen_concurrency 的 max）→ 改动 POST { [numField]: value }。
  //   后端已接收该字段（endpoints.mjs POST /api/security/gen-concurrency:2291 max>0 落盘）。
  root.querySelectorAll('[data-sec-ctrl="switch-num"]').forEach((el) => {
    const it = byId[el.dataset.secId];
    if (!it) return;
    el.addEventListener("change", async () => {
      const c = it.control;
      const want = parseInt(el.value, 10);
      if (!Number.isFinite(want) || want <= 0) { el.value = String(c.numValue ?? ""); return; } // 非法回滚
      el.disabled = true;
      try {
        const d = await sendAction({ verb: "ctrlPost", target: "server:security", source: "web", payload: { _endpoint: c.endpoint, [c.numField]: want } });
        if (!d || d.success === false) throw new Error(d?.error || "保存失败");
        c.numValue = (d[c.numField] !== undefined) ? d[c.numField] : want; // 后端回传权威值
        el.value = String(c.numValue);
      } catch (e) {
        showToast("error", "保存失败: " + e.message);
        el.value = String(c.numValue ?? ""); // 回滚
      } finally { el.disabled = false; }
    });
  });

  // list（如 CORS 域白名单）：add/remove tag → POST 完整数组
  root.querySelectorAll('[data-sec-ctrl="list"]').forEach((wrap) => {
    const it = byId[wrap.dataset.secId];
    if (!it) return;
    const c = it.control;
    const rerender = (vals) => {
      const tagsDiv = wrap.querySelector(".flex.flex-wrap");
      if (!tagsDiv) return;
      if (vals.length === 0) {
        tagsDiv.innerHTML = '<span class="text-xs text-base-content/40">（空）</span>';
      } else {
        tagsDiv.innerHTML = vals.map((v) =>
          `<span class="badge badge-sm badge-outline gap-1" data-sec-list-val="${_escHtmlBasic(v)}">${_escHtmlBasic(v)}<button class="btn btn-ghost btn-xs px-0" data-sec-list-rm="${_escHtmlBasic(v)}">✕</button></span>`
        ).join("");
      }
      _wireListRemove(wrap, it, vals);
    };
    const save = async (vals) => {
      try {
        // 原 raw POST c.endpoint（动态 URL）{origins:vals} → 门面 ctrlPost；门面返回解析体
        const d = await sendAction({ verb: "ctrlPost", target: "server:security", source: "web", payload: { _endpoint: c.endpoint, origins: vals } });
        if (!d || d.success === false) throw new Error(d?.error || "保存失败");
        c.value = d.origins || vals;
        rerender(c.value);
      } catch (e) { showToast("error", "保存失败: " + e.message); }
    };
    const addBtn = wrap.querySelector(`[data-sec-list-add]`);
    const addInput = wrap.querySelector(`[data-sec-list-input]`);
    if (addBtn && addInput) {
      const doAdd = () => {
        const v = addInput.value.trim();
        if (!v) return;
        const cur = Array.isArray(c.value) ? [...c.value] : [];
        if (!cur.includes(v)) { cur.push(v); save(cur); }
        addInput.value = "";
      };
      addBtn.addEventListener("click", doAdd);
      addInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doAdd(); } });
    }
    const _wireListRemove = (w, item, vals) => {
      w.querySelectorAll("[data-sec-list-rm]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const rmVal = btn.dataset.secListRm;
          const next = vals.filter((x) => x !== rmVal);
          save(next);
        });
      });
    };
    _wireListRemove(wrap, it, Array.isArray(c.value) ? c.value : []);
  });

  // ejs: 异步拉 part config 回填初值 + 绑定保存
  const ejsEl = root.querySelector('[data-sec-ctrl="ejs-timeout"]');
  if (ejsEl) {
    const it = byId[ejsEl.dataset.secId];
    const optEl = root.querySelector('[data-sec-ctrl="ejs-optout"]');
    const c = it?.control;
    if (c) {
      // 原 raw GET c.endpointGet（动态 URL）→ 门面 ctrlGet 动态端点路由；失败 catch 静默（等价原 .catch(()=>{})）
      sendAction({ verb: "ctrlGet", target: "server:security", source: "web", payload: { _endpoint: c.endpointGet } })
        .then((d) => {
          if (!d) return;
          if (d[c.timeoutField] !== undefined) ejsEl.value = d[c.timeoutField];
          if (optEl && d[c.optOutField] !== undefined) {
            optEl.checked = d[c.optOutField] === true;
            _toggleEjsOptOutRisk(ejsEl, optEl.checked, c);
          }
        })
        .catch(() => {});
      const saveEjs = async (patch) => {
        try {
          // 原 raw POST c.endpointSet（动态 URL）→ 门面 ctrlPost；返回体不消费（原 fire-and-forget）
          await sendAction({ verb: "ctrlPost", target: "server:security", source: "web", payload: { _endpoint: c.endpointSet, ...patch } });
        } catch (e) { showToast("error", "EJS 设置保存失败: " + e.message); }
      };
      ejsEl.addEventListener("change", () => {
        const t = Number(ejsEl.value);
        if (Number.isFinite(t) && t >= 100) saveEjs({ [c.timeoutField]: t });
      });
      if (optEl) optEl.addEventListener("change", () => {
        saveEjs({ [c.optOutField]: optEl.checked });
        _toggleEjsOptOutRisk(ejsEl, optEl.checked, c);
      });
    }
  }
}

// select 风险红字刷新（值变化后）
function _refreshSecRisk(el, it, val) {
  const row = el.closest(".bg-base-200");
  if (!row) return;
  const opt = (it.control.options || []).find((o) => o.value === val);
  let r = row.querySelector('[data-sec-risk="1"]');
  if (opt && opt.risk) {
    if (!r) {
      r = document.createElement("div");
      r.className = "text-xs text-error mt-0.5";
      r.dataset.secRisk = "1";
      row.appendChild(r);
    }
    r.innerHTML = _secIcon("warning") + " " + _escHtmlBasic(opt.risk);  } else if (r) { r.remove(); }
}
function _refreshSecRiskBool(el, it, on) {
  const row = el.closest(".bg-base-200");
  if (!row) return;
  let r = row.querySelector('[data-sec-risk="1"]');
  if (on && it.control.risk) {
    if (!r) {
      r = document.createElement("div");
      r.className = "text-xs text-error mt-0.5";
      r.dataset.secRisk = "1";
      row.appendChild(r);
    }
    r.innerHTML = _secIcon("warning") + " " + _escHtmlBasic(it.control.risk);  } else if (r) { r.remove(); }
}
function _toggleEjsOptOutRisk(anchorEl, on, c) {
  const row = anchorEl.closest(".bg-base-200");
  if (!row) return;
  let r = row.querySelector('[data-sec-risk="1"]');
  if (on && c.optOutRisk) {
    if (!r) {
      r = document.createElement("div");
      r.className = "text-xs text-error mt-0.5";
      r.dataset.secRisk = "1";
      row.appendChild(r);
    }
    r.innerHTML = _secIcon("warning") + " " + _escHtmlBasic(c.optOutRisk);  } else if (r) { r.remove(); }
}

const _escHtmlBasic = escapeHtml;

export { _initSecurityCenter };

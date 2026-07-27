// ═══════════════════════════════════════════════════════════════════════════
// 触碰热区编辑器(凛倾 2026-07-09 触碰设计,自 companion.mjs 拆出独立模块)
// 功能链:
//   识别(渲染层 live2dRenderer.hitAt):live2d=部件集合(实时随动作)>模型自带 HitArea>形状;图片=形状(按 scope 过滤)
//   本编辑器=产出热区数据:
//     区={name, drawables?|hitArea?|shape?{kind:poly|circle|rect,...}, scope?{file|key}(图片包),
//        reactions?{手势:[{step,type,value}]}, action?{type,value}(简单单反应)}
//   存储单源:图片包=pack.json.hitAreas(saveImagepack)/Live2D=usermodel 条目(saveUserModel 字段级 merge)
//   枚举/限值/样式零本地副本:caps.hitActionTypes/hitGestures/hitShapes/hitLimits/hitEditor(data/pet_capabilities.json 可覆盖)
// UI 两层:
//   ① 面板段(index.html #comp-seg-hit 既有 DOM):列表+快捷(live2d 点选部件/自带区 chips/图片快速套索)
//   ② 放大编辑器(模态,本模块动态建 DOM):大画布+形状工具+图片包分图作用域+反馈步骤+导出导入
// ═══════════════════════════════════════════════════════════════════════════
import { sendAction } from "../../shared/transport/sendAction.mjs";
import { escapeHtml } from "../../shared/state/utils.mjs"; // T7：HTML 转义收口到唯一权威实现（5 字符含单引号）
import { beiluConfirm } from "../../shared/widgets/beiluDialog.mjs"; // 0714 扫尾：window.confirm 漏迁（全壳已统一 beiluDialog）

let _caps = () => null;      // companion 注入:() => _petCaps(能力单源持有方仍是 companion)
let _ipkNames = () => new Set(); // companion 注入:() => 图片包名集合
const _esc = escapeHtml; // T7：alias 到唯一权威实现（原本地 5 字符 replace 链已删，从未被重赋值）

let _areas = [], _kind = "", _model = "", _showOn = false;

const $id = (i) => document.getElementById(i);
function _status(t, err) { const s = $id("hit-status"); if (s) { s.textContent = t || ""; s.className = "text-[10px] ml-auto " + (err ? "text-error" : "text-success"); } }
function _limits() { const c = _caps(); return (c && c.hitLimits && typeof c.hitLimits === "object") ? c.hitLimits : {}; }
function _types() { const c = _caps(); return (Array.isArray(c && c.hitActionTypes) && c.hitActionTypes.length) ? c.hitActionTypes : []; }
function _gestures() { const c = _caps(); return (Array.isArray(c && c.hitGestures) && c.hitGestures.length) ? c.hitGestures : []; }
function _shapes() { const c = _caps(); return (Array.isArray(c && c.hitShapes) && c.hitShapes.length) ? c.hitShapes : []; }
function _edStyle() { const c = _caps(); return (c && c.hitEditor && typeof c.hitEditor === "object") ? c.hitEditor : {}; }

// ── 数据读写(单源链同微调/图片包) ──
export async function hitEditorLoad(modelName) {
  _model = modelName || ""; _kind = ""; _areas = [];
  const nameEl = $id("hit-cur-model");
  if (nameEl) nameEl.textContent = _model ? `${_model}（${_ipkNames().has(_model) ? "图片包" : "Live2D"}）` : "(默认小生物,无热区)";
  if (_model) {
    if (_ipkNames().has(_model)) {
      _kind = "image";
      try { const r = await fetch(`/api/eye/user-images/${encodeURIComponent(_model)}/pack.json`, { cache: "no-store" }); if (r.ok) { const pj = await r.json(); if (Array.isArray(pj.hitAreas)) _areas = pj.hitAreas; } } catch (e) { /* 离线:空 */ }
    } else {
      _kind = "live2d";
      try { const arr = await sendAction({ verb: "getUserModelDict", target: "server:eye", source: "web" }); const ent = Array.isArray(arr) ? arr.find(m => m && m.name === _model) : null; if (ent && Array.isArray(ent.hitAreas)) _areas = ent.hitAreas; } catch (e) { /* 离线:空 */ }
    }
  }
  _renderRows(); _drawPanelOverlay(_showOn);
}
async function _save() {
  if (!_model || !_kind) { _status("先在\u201c桌宠形象\u201d选形象", true); return false; }
  try {
    if (_kind === "image") {
      const r = await fetch(`/api/eye/user-images/${encodeURIComponent(_model)}/pack.json`, { cache: "no-store" });
      if (!r.ok) throw new Error("包读取失败 HTTP " + r.status); // 防覆盖:拿不到最新包=中止不带病提交(T021 同族)
      const pj = await r.json();
      if (_areas.length) pj.hitAreas = _areas; else delete pj.hitAreas;
      await sendAction({ verb: "saveImagepack", target: "server:eye", source: "web", payload: { pack: _model, json: pj } });
    } else {
      await sendAction({ verb: "saveUserModel", target: "server:eye", source: "web", payload: { name: _model, hitAreas: _areas } });
    }
    _status("已保存 · 桌宠数秒内同步生效");
    try { if (window.beiluLive2d && window.beiluLive2d.reloadDict) await window.beiluLive2d.reloadDict(); } catch (e) { /* 预览未就绪 */ }
    return true;
  } catch (e) { _status("保存失败: " + e.message, true); return false; }
}

// ── 面板段:区列表(简行)+自带区 chips ──
function _shapeLabel(a) {
  if (Array.isArray(a.drawables) && a.drawables.length) return `部件×${a.drawables.length}(跟随动作)`;
  if (a.hitArea) return `自带区:${a.hitArea}`;
  const sh = a.shape || (Array.isArray(a.poly) ? { kind: "poly", points: a.poly } : null);
  if (!sh) return "(无形状)";
  if (sh.kind === "circle") return "圆";
  if (sh.kind === "rect") return "矩形";
  return `套索${Array.isArray(sh.points) ? sh.points.length : (a.poly || []).length}点`;
}
function _scopeLabel(a) {
  const sc = a.scope; if (!sc) return "全包";
  if (sc.file) return `图:${sc.file}`;
  if (sc.key) return `键:${sc.key}`;
  return "全包";
}
function _renderRows() {
  const host = $id("hit-rows");
  if (!host) return;
  host.innerHTML = "";
  if (!_model) { host.innerHTML = '<span class="opacity-40">默认小生物不支持热区;先在\u201c桌宠形象\u201d选 Live2D 模型或图片包。</span>'; return; }
  // 模型自带 HitAreas 一键加(live2d)
  const mhn = (window.beiluLive2d && window.beiluLive2d.modelHitAreaNames) ? window.beiluLive2d.modelHitAreaNames() : [];
  const used = new Set(_areas.map(a => a.hitArea).filter(Boolean));
  const freeHA = mhn.filter(n => !used.has(n));
  if (_kind === "live2d" && freeHA.length) {
    const chipRow = document.createElement("div");
    chipRow.className = "flex items-center gap-1 flex-wrap";
    chipRow.innerHTML = '<span class="opacity-50">模型自带部位区(点击添加):</span>' +
      freeHA.map(n => `<button data-ha="${_esc(n)}" class="btn btn-xs btn-outline btn-warning">${_esc(n)}</button>`).join("");
    chipRow.querySelectorAll("[data-ha]").forEach(b => b.addEventListener("click", () => {
      const dt = _types()[0]; if (!dt) { _status("动作类型来自 beilu 后端,当前不可达", true); return; }
      _areas.push({ name: b.dataset.ha, hitArea: b.dataset.ha, action: { type: dt.value, value: "" } });
      _renderRows(); _save(); _drawPanelOverlay(_showOn);
    }));
    host.appendChild(chipRow);
  }
  if (!_areas.length) {
    const tip = document.createElement("span"); tip.className = "opacity-40";
    tip.textContent = _kind === "live2d"
      ? "还没有热区。\u201c点选部件\u201d在预览上选部位(随动作跟形),或点上方自带部位区;\u201c放大编辑器\u201d可画形状。"
      : "还没有热区。用\u201c放大编辑器\u201d在大图上画形状(套索/圆/矩形,可按图片/表情键分别设置)。";
    host.appendChild(tip); return;
  }
  _areas.forEach((a, i) => {
    const row = document.createElement("div");
    row.className = "flex items-center gap-2 bg-base-300/30 rounded px-2 py-1 text-xs";
    row.innerHTML =
      `<span class="font-bold">${_esc(a.name || ("热区" + (i + 1)))}</span>` +
      `<span class="opacity-50 text-[10px]">${_esc(_shapeLabel(a))}${_kind === "image" ? " · " + _esc(_scopeLabel(a)) : ""}</span>` +
      `<span class="opacity-40 text-[10px] ml-auto">${a.reactions ? "多步反馈" : ((a.action && a.action.type) || "")}</span>` +
      `<button data-f="edit" class="btn btn-xs btn-ghost">编辑反馈</button>` +
      `<button data-f="del" class="btn btn-xs btn-ghost text-error/70">删</button>`;
    row.querySelector('[data-f="del"]').addEventListener("click", () => { _areas.splice(i, 1); _save(); _renderRows(); _drawPanelOverlay(_showOn); });
    row.querySelector('[data-f="edit"]').addEventListener("click", () => _openModal(a));
    host.appendChild(row);
  });
}

// ── 面板预览 overlay(既有热区可视化;色=主题 currentColor) ──
function _panelOverlayEl(create) {
  const lh = $id("live2d-host");
  if (!lh || !lh.parentElement) return null;
  let ov = $id("hit-overlay");
  if (!ov && create) {
    ov = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    ov.id = "hit-overlay";
    ov.classList.add("text-warning");
    ov.style.cssText = "position:absolute;inset:0;z-index:30;pointer-events:none;width:100%;height:100%;";
    lh.parentElement.appendChild(ov);
  }
  return ov;
}
function _svgShape(sh, f, es) {
  const NS = "http://www.w3.org/2000/svg";
  let el = null;
  if (sh.kind === "poly" && Array.isArray(sh.points) && sh.points.length >= 3) {
    el = document.createElementNS(NS, "polygon");
    el.setAttribute("points", sh.points.map(p => `${(f.x + p[0] * f.w).toFixed(1)},${(f.y + p[1] * f.h).toFixed(1)}`).join(" "));
  } else if (sh.kind === "rect") {
    el = document.createElementNS(NS, "rect");
    el.setAttribute("x", (f.x + sh.x * f.w).toFixed(1)); el.setAttribute("y", (f.y + sh.y * f.h).toFixed(1));
    el.setAttribute("width", (sh.w * f.w).toFixed(1)); el.setAttribute("height", (sh.h * f.h).toFixed(1));
  } else if (sh.kind === "circle") {
    el = document.createElementNS(NS, "ellipse"); // r 归一化于宽,屏幕=真圆(命中同定义)
    el.setAttribute("cx", (f.x + sh.cx * f.w).toFixed(1)); el.setAttribute("cy", (f.y + sh.cy * f.h).toFixed(1));
    el.setAttribute("rx", (sh.r * f.w).toFixed(1)); el.setAttribute("ry", (sh.r * f.w).toFixed(1));
  }
  if (el) {
    el.setAttribute("stroke", "currentColor"); el.setAttribute("fill", "currentColor");
    if (es.fillOpacity != null) el.setAttribute("fill-opacity", String(es.fillOpacity));
    if (es.dash) el.setAttribute("stroke-dasharray", String(es.dash));
    if (es.strokeWidth != null) el.setAttribute("stroke-width", String(es.strokeWidth));
  }
  return el;
}
function _drawPanelOverlay(show) {
  const ov = _panelOverlayEl(show);
  if (!ov) return;
  ov.innerHTML = "";
  if (!show) return;
  const f = window.beiluLive2d && window.beiluLive2d.hitFrame && window.beiluLive2d.hitFrame();
  if (!f) return;
  const es = _edStyle();
  const NS = "http://www.w3.org/2000/svg";
  for (const a of _areas) {
    if (Array.isArray(a.drawables) && a.drawables.length) {
      for (const id of a.drawables) {
        const b = window.beiluLive2d.drawableBoundsHost && window.beiluLive2d.drawableBoundsHost(id);
        if (!b) continue;
        const rc = document.createElementNS(NS, "rect");
        rc.setAttribute("x", b.x.toFixed(1)); rc.setAttribute("y", b.y.toFixed(1));
        rc.setAttribute("width", b.w.toFixed(1)); rc.setAttribute("height", b.h.toFixed(1));
        rc.setAttribute("stroke", "currentColor"); rc.setAttribute("fill", "currentColor");
        if (es.fillOpacity != null) rc.setAttribute("fill-opacity", String(es.fillOpacity));
        ov.appendChild(rc);
      }
      continue;
    }
    const sh = a.shape || (Array.isArray(a.poly) && a.poly.length >= 3 ? { kind: "poly", points: a.poly } : null);
    if (!sh) continue;
    const el = _svgShape(sh, f, es);
    if (el) { const ti = document.createElementNS(NS, "title"); ti.textContent = a.name || ""; el.appendChild(ti); ov.appendChild(el); }
  }
}

// ── live2d 点选部件(面板内,实时) ──
function _partPick() {
  const ov = _panelOverlayEl(true);
  if (!ov) { _status("预览容器不存在", true); return; }
  const picked = new Set();
  _status("点预览上的角色部位选部件(再点=取消该件);【Enter】完成命名,【Esc】取消");
  _showOn = true; _drawPanelOverlay(true);
  ov.style.pointerEvents = "auto"; ov.style.cursor = "crosshair";
  const NS = "http://www.w3.org/2000/svg";
  const drawPicked = () => {
    ov.querySelectorAll(".hit-pick").forEach(n => n.remove());
    for (const id of picked) {
      const b = window.beiluLive2d.drawableBoundsHost(id);
      if (!b) continue;
      const rc = document.createElementNS(NS, "rect");
      rc.setAttribute("class", "hit-pick");
      rc.setAttribute("x", b.x.toFixed(1)); rc.setAttribute("y", b.y.toFixed(1));
      rc.setAttribute("width", b.w.toFixed(1)); rc.setAttribute("height", b.h.toFixed(1));
      rc.setAttribute("stroke", "currentColor"); rc.setAttribute("fill", "currentColor"); rc.setAttribute("fill-opacity", "0.2");
      ov.appendChild(rc);
    }
  };
  const click = (e) => {
    const hits = window.beiluLive2d.drawablesAt(e.clientX, e.clientY);
    if (!hits.length) { _status("该点没有部件(点到角色身上)", true); return; }
    const best = hits.find(h => picked.has(h.id)) || hits[0];
    if (picked.has(best.id)) picked.delete(best.id); else picked.add(best.id);
    _status(`已选 ${picked.size} 个部件——Enter 完成,Esc 取消`);
    drawPicked(); e.preventDefault();
  };
  const key = (e) => {
    if (e.key === "Escape") { cleanup(); _status("已取消"); _drawPanelOverlay(_showOn); return; }
    if (e.key === "Enter") {
      if (!picked.size) { _status("还没选部件", true); return; }
      cleanup();
      const dt = _types()[0]; if (!dt) { _status("动作类型来自 beilu 后端,当前不可达", true); return; }
      const area = { name: "热区" + (_areas.length + 1), drawables: [...picked], action: { type: dt.value, value: "" } };
      _areas.push(area);
      _renderRows(); _save(); _drawPanelOverlay(true);
      _openModal(area); // 直接进反馈编辑
    }
  };
  function cleanup() {
    ov.removeEventListener("pointerdown", click);
    window.removeEventListener("keydown", key);
    ov.querySelectorAll(".hit-pick").forEach(n => n.remove());
    ov.style.pointerEvents = "none"; ov.style.cursor = "";
  }
  ov.addEventListener("pointerdown", click);
  window.addEventListener("keydown", key);
}

// ── 放大编辑器(模态):大画布+形状工具+图片包分图作用域+反馈步骤+导出导入 ──
let _modal = null;
function _closeModal() { if (_modal) { _modal.remove(); _modal = null; } }
async function _openModal(focusArea) {
  _closeModal();
  if (!_model) { _status("先在\u201c桌宠形象\u201d选形象", true); return; }
  const types = _types(), gestures = _gestures(), shapes = _shapes();
  if (!types.length || !gestures.length) { _status("动作/手势枚举来自 beilu 后端(caps),当前不可达", true); return; }
  const m = document.createElement("div");
  _modal = m;
  m.className = "fixed inset-0 z-[999] bg-black/60 flex items-center justify-center p-4";
  m.innerHTML =
    `<div class="bg-base-200 rounded-xl shadow-xl w-full h-full max-w-6xl flex flex-col overflow-hidden">
      <div class="flex items-center gap-2 px-3 py-2 border-b border-base-300 text-xs flex-wrap">
        <span class="font-bold text-sm">触碰热区 · ${_esc(_model)}（${_kind === "image" ? "图片包" : "Live2D"}）</span>
        <span id="hm-imgsel-wrap" class="flex items-center gap-1 ${_kind === "image" ? "" : "hidden"}">
          <span class="opacity-50">图:</span><select id="hm-key" class="select select-xs select-bordered"></select><select id="hm-file" class="select select-xs select-bordered"></select>
          <span class="opacity-50 ml-1">新区作用域:</span>
          <select id="hm-scope" class="select select-xs select-bordered">
            <option value="file">仅这张图</option><option value="key">这个表情键</option><option value="">全包</option>
          </select>
        </span>
        <button id="hm-snap" class="btn btn-xs ${_kind === "live2d" ? "" : "hidden"}" title="以当前预览画面为底图(套索等静态形状用;部件区请用面板点选)">重拍快照</button>
        <span class="opacity-50 ml-2">形状:</span>
        <select id="hm-shape" class="select select-xs select-bordered">${shapes.map(s => `<option value="${_esc(s.value)}">${_esc(s.label || s.value)}</option>`).join("")}</select>
        <button id="hm-draw" class="btn btn-xs btn-warning">画新热区</button>
        <span id="hm-status" class="text-[10px] opacity-60"></span>
        <span class="ml-auto flex items-center gap-1">
          <button id="hm-export" class="btn btn-xs btn-ghost" title="导出当前形象全部热区为 JSON 文件">导出</button>
          <button id="hm-import" class="btn btn-xs btn-ghost" title="从 JSON 文件导入(替换当前形象热区)">导入</button>
          <button id="hm-close" class="btn btn-xs">关闭</button>
        </span>
      </div>
      <div class="flex-1 flex min-h-0">
        <div id="hm-canvas" class="flex-1 relative bg-base-300/30 overflow-hidden flex items-center justify-center">
          <img id="hm-img" class="max-w-full max-h-full object-contain select-none" draggable="false" />
          <svg id="hm-svg" class="absolute text-warning" style="pointer-events:none"></svg>
        </div>
        <div id="hm-list" class="w-96 shrink-0 border-l border-base-300 overflow-y-auto p-2 flex flex-col gap-2 text-xs"></div>
      </div>
    </div>`;
  document.body.appendChild(m);
  m.addEventListener("click", (e) => { if (e.target === m) _closeModal(); });
  $id("hm-close").addEventListener("click", _closeModal);
  // 底图:图片包=选中的图片文件;live2d=渲染快照
  const img = $id("hm-img");
  let _packJson = null;
  const _loadPack = async () => {
    try { const r = await fetch(`/api/eye/user-images/${encodeURIComponent(_model)}/pack.json`, { cache: "no-store" }); if (r.ok) _packJson = await r.json(); } catch (e) { _packJson = null; }
  };
  const _fillKeyFile = () => {
    const kSel = $id("hm-key"), fSel = $id("hm-file");
    if (!kSel || !fSel || !_packJson) return;
    const keys = Object.keys(_packJson.expressions || {});
    kSel.innerHTML = keys.map(k => `<option value="${_esc(k)}">${_esc(k)}</option>`).join("");
    const fillFiles = () => {
      const v = _packJson.expressions[kSel.value];
      const files = Array.isArray(v) ? v : (v ? [v] : []);
      fSel.innerHTML = files.map(fn => `<option value="${_esc(fn)}">${_esc(fn)}</option>`).join("");
      img.src = fSel.value ? `/api/eye/user-images/${encodeURIComponent(_model)}/${encodeURIComponent(fSel.value)}` : "";
      _redraw();
    };
    kSel.onchange = fillFiles;
    fSel.onchange = () => { img.src = `/api/eye/user-images/${encodeURIComponent(_model)}/${encodeURIComponent(fSel.value)}`; _redraw(); };
    fillFiles();
  };
  const _takeSnap = () => {
    const d = window.beiluLive2d && window.beiluLive2d.snapshot ? window.beiluLive2d.snapshot() : "";
    if (d) { img.src = d; _redraw(); } else { $id("hm-status").textContent = "快照失败:预览未渲染 Live2D"; }
  };
  if (_kind === "image") { await _loadPack(); _fillKeyFile(); }
  else { $id("hm-snap").addEventListener("click", _takeSnap); _takeSnap(); }
  // 画布坐标系:归一化相对 img 显示框(图片包=图片文件系=渲染端 fitRect 同语义;
  //   live2d 快照=host 全幅,须再换算 hitFrame 子区→与渲染端基准框同系)。
  let _snapFrame = null; // live2d:快照时的 hitFrame(host px)与 host 尺寸
  const _snapMeta = () => {
    if (_kind !== "live2d") { _snapFrame = null; return; }
    const lh = $id("live2d-host");
    const f = window.beiluLive2d.hitFrame && window.beiluLive2d.hitFrame();
    _snapFrame = (lh && f) ? { f, hw: lh.clientWidth, hh: lh.clientHeight } : null;
  };
  _snapMeta();
  $id("hm-snap") && $id("hm-snap").addEventListener("click", _snapMeta);
  const _imgRect = () => img.getBoundingClientRect();
  // 显示框 → 基准框归一化(双向)
  const _toNorm = (cx, cy) => {
    const r = _imgRect();
    let nx = (cx - r.left) / r.width, ny = (cy - r.top) / r.height;
    if (_kind === "live2d" && _snapFrame) { // 快照全幅 → hitFrame 子区
      const { f, hw, hh } = _snapFrame;
      nx = (nx * hw - f.x) / f.w; ny = (ny * hh - f.y) / f.h;
    }
    return [nx, ny];
  };
  const _normFrameInImg = () => { // 基准框在 img 显示框内的 px 矩形(SVG 画既有区用)
    const r = _imgRect();
    if (_kind === "live2d" && _snapFrame) {
      const { f, hw, hh } = _snapFrame;
      return { x: (f.x / hw) * r.width, y: (f.y / hh) * r.height, w: (f.w / hw) * r.width, h: (f.h / hh) * r.height };
    }
    return { x: 0, y: 0, w: r.width, h: r.height };
  };
  const svg = $id("hm-svg");
  const _syncSvg = () => {
    const r = _imgRect(), host = $id("hm-canvas").getBoundingClientRect();
    svg.style.left = (r.left - host.left) + "px"; svg.style.top = (r.top - host.top) + "px";
    svg.style.width = r.width + "px"; svg.style.height = r.height + "px";
    svg.setAttribute("viewBox", `0 0 ${r.width} ${r.height}`);
  };
  const _visibleAreas = () => _areas.filter(a => {
    if (_kind !== "image") return !a.drawables && !a.hitArea; // live2d 模态只画形状区(部件区在面板实时看)
    const sc = a.scope;
    if (!sc) return true;
    if (sc.file) return sc.file === ($id("hm-file") && $id("hm-file").value);
    if (sc.key) return sc.key === ($id("hm-key") && $id("hm-key").value);
    return true;
  });
  const _redraw = () => {
    if (!img.complete || !img.naturalWidth) { img.onload = () => _redraw(); return; }
    _syncSvg();
    svg.innerHTML = "";
    const f = _normFrameInImg();
    const es = _edStyle();
    for (const a of _visibleAreas()) {
      const sh = a.shape || (Array.isArray(a.poly) && a.poly.length >= 3 ? { kind: "poly", points: a.poly } : null);
      if (!sh) continue;
      const el = _svgShape(sh, f, es);
      if (el) { const ti = document.createElementNS("http://www.w3.org/2000/svg", "title"); ti.textContent = a.name || ""; el.appendChild(ti); svg.appendChild(el); }
    }
    _renderModalList();
  };
  // 画新形状
  $id("hm-draw").addEventListener("click", () => {
    const kind = $id("hm-shape").value;
    const hs = $id("hm-status");
    hs.textContent = kind === "poly" ? "按住沿目标画一圈,松手闭合(Esc 取消)" : "按住拖出形状,松手完成(Esc 取消)";
    svg.style.pointerEvents = "auto"; svg.style.cursor = "crosshair";
    const es = _edStyle();
    const sample = Number(_limits().lassoSamplePx) || 6;
    const minPts = Number(_limits().minPolyPoints) || 3;
    let drawing = false, pts = [], sx = 0, sy = 0, ghost = null;
    const NS = "http://www.w3.org/2000/svg";
    const rel = (e) => { const r = _imgRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    const down = (e) => {
      drawing = true; [sx, sy] = [e.clientX, e.clientY]; pts = [[e.clientX, e.clientY]];
      ghost = document.createElementNS(NS, kind === "poly" ? "polyline" : (kind === "circle" ? "ellipse" : "rect"));
      ghost.setAttribute("stroke", "currentColor"); ghost.setAttribute("fill", kind === "poly" ? "none" : "currentColor");
      if (kind !== "poly" && es.fillOpacity != null) ghost.setAttribute("fill-opacity", String(es.fillOpacity));
      if (es.lineWidth != null) ghost.setAttribute("stroke-width", String(es.lineWidth));
      svg.appendChild(ghost); e.preventDefault();
    };
    const move = (e) => {
      if (!drawing || !ghost) return;
      if (kind === "poly") {
        const last = pts[pts.length - 1];
        if (Math.abs(e.clientX - last[0]) + Math.abs(e.clientY - last[1]) < sample) return;
        pts.push([e.clientX, e.clientY]);
        const r = _imgRect();
        ghost.setAttribute("points", pts.map(p => `${p[0] - r.left},${p[1] - r.top}`).join(" "));
      } else if (kind === "rect") {
        const [x1, y1] = rel({ clientX: Math.min(sx, e.clientX), clientY: Math.min(sy, e.clientY) });
        ghost.setAttribute("x", x1); ghost.setAttribute("y", y1);
        ghost.setAttribute("width", Math.abs(e.clientX - sx)); ghost.setAttribute("height", Math.abs(e.clientY - sy));
      } else {
        const [cx, cy] = rel({ clientX: sx, clientY: sy });
        const rr = Math.hypot(e.clientX - sx, e.clientY - sy);
        ghost.setAttribute("cx", cx); ghost.setAttribute("cy", cy); ghost.setAttribute("rx", rr); ghost.setAttribute("ry", rr);
      }
    };
    const up = (e) => {
      if (!drawing) return;
      cleanup();
      const f = _normFrameInImg();
      const toN = (cx, cy) => _toNorm(cx, cy);
      let shape = null;
      if (kind === "poly") {
        if (pts.length < minPts) { hs.textContent = `轨迹太短(至少 ${minPts} 点),已取消`; _redraw(); return; }
        shape = { kind: "poly", points: pts.map(p => toN(p[0], p[1]).map(n => Math.round(n * 1000) / 1000)) };
      } else if (kind === "rect") {
        const [x1, y1] = toN(Math.min(sx, e.clientX), Math.min(sy, e.clientY));
        const [x2, y2] = toN(Math.max(sx, e.clientX), Math.max(sy, e.clientY));
        if (x2 - x1 < 0.01 || y2 - y1 < 0.01) { hs.textContent = "太小,已取消"; _redraw(); return; }
        shape = { kind: "rect", x: +x1.toFixed(3), y: +y1.toFixed(3), w: +(x2 - x1).toFixed(3), h: +(y2 - y1).toFixed(3) };
      } else {
        const [cx, cy] = toN(sx, sy);
        const rPx = Math.hypot(e.clientX - sx, e.clientY - sy);
        const rN = rPx / _imgRect().width * (_imgRect().width / (f.w || _imgRect().width)); // 屏幕半径→基准框宽归一
        if (rN < 0.01) { hs.textContent = "太小,已取消"; _redraw(); return; }
        shape = { kind: "circle", cx: +cx.toFixed(3), cy: +cy.toFixed(3), r: +rN.toFixed(3) };
      }
      const area = { name: "热区" + (_areas.length + 1), shape, action: { type: _types()[0].value, value: "" } };
      if (_kind === "image") {
        const sv = $id("hm-scope").value;
        if (sv === "file" && $id("hm-file").value) area.scope = { file: $id("hm-file").value };
        else if (sv === "key" && $id("hm-key").value) area.scope = { key: $id("hm-key").value };
      }
      _areas.push(area);
      _save(); _renderRows(); _redraw();
      hs.textContent = "已加热区,在右侧配反馈";
    };
    const key = (e) => { if (e.key === "Escape") { cleanup(); hs.textContent = "已取消"; _redraw(); } };
    function cleanup() {
      svg.removeEventListener("pointerdown", down); svg.removeEventListener("pointermove", move); svg.removeEventListener("pointerup", up);
      window.removeEventListener("keydown", key);
      svg.style.pointerEvents = "none"; svg.style.cursor = "";
      if (ghost) { ghost.remove(); ghost = null; }
      drawing = false;
    }
    svg.addEventListener("pointerdown", down);
    svg.addEventListener("pointermove", move);
    svg.addEventListener("pointerup", up);
    window.addEventListener("keydown", key);
  });
  // 右侧:区列表+反馈步骤编辑
  const list = $id("hm-list");
  const _renderModalList = () => {
    list.innerHTML = "";
    const vis = _kind === "image" ? _areas : _areas; // 全列(含部件区,反馈也要能配)
    if (!vis.length) { list.innerHTML = '<span class="opacity-40">左侧画形状,或面板\u201c点选部件\u201d后回这里配反馈。</span>'; return; }
    const maxSay = Number(_limits().sayMaxChars) || 0;
    vis.forEach((a, i) => {
      const card = document.createElement("div");
      card.className = "bg-base-300/30 rounded p-2 flex flex-col gap-1.5" + (a === focusArea ? " ring-1 ring-warning" : "");
      const gTabs = gestures.map(g => `<option value="${_esc(g.value)}">${_esc(g.label || g.value)}</option>`).join("");
      card.innerHTML =
        `<div class="flex items-center gap-1">
          <input data-f="name" class="input input-xs input-bordered w-24" value="${_esc(a.name || ("热区" + (i + 1)))}"/>
          <span class="opacity-40 text-[10px]">${_esc(_shapeLabel(a))}${_kind === "image" ? " · " + _esc(_scopeLabel(a)) : ""}</span>
          <button data-f="del" class="btn btn-xs btn-ghost text-error/70 ml-auto">删区</button>
        </div>
        <div class="flex items-center gap-1"><span class="opacity-50">手势:</span><select data-f="gesture" class="select select-xs select-bordered">${gTabs}</select>
          <button data-f="addstep" class="btn btn-xs btn-ghost">+步骤</button>
          <span class="opacity-40 text-[10px]" title="同区同手势按累计触发次数取档;窗口=caps.countResetMs,区级 countResetMs 可覆盖">次数细分</span></div>
        <div data-f="steps" class="flex flex-col gap-1"></div>`;
      const gSel = card.querySelector('[data-f="gesture"]');
      const stepsHost = card.querySelector('[data-f="steps"]');
      const renderSteps = () => {
        const g = gSel.value;
        if (!a.reactions || typeof a.reactions !== "object") a.reactions = {};
        // 迁移:旧 action 作为该手势第一步的初值显示(不复制到别的手势)
        const arr = Array.isArray(a.reactions[g]) ? a.reactions[g]
          : (g === "click" && a.action && a.action.type ? [{ step: 1, type: a.action.type, value: a.action.value || "" }] : []);
        a.reactions[g] = arr;
        stepsHost.innerHTML = "";
        if (!arr.length) { stepsHost.innerHTML = '<span class="opacity-40 text-[10px]">该手势暂无反馈,点 +步骤 添加(第1步=每次触发;第N步=第N次起替换)。</span>'; return; }
        arr.forEach((st, si) => {
          const row = document.createElement("div");
          row.className = "flex items-start gap-1";
          const tOpts = types.map(t => `<option value="${_esc(t.value)}"${st.type === t.value ? " selected" : ""}>${_esc(t.label || t.value)}</option>`).join("");
          const hint = (types.find(t => t.value === st.type) || {}).hint || "";
          row.innerHTML =
            `<label class="flex items-center gap-0.5 shrink-0" title="第几次触发起用这档"><span class="opacity-40 text-[10px]">第</span><input data-s="step" type="number" min="1" class="input input-xs input-bordered w-12" value="${Number(st.step) || 1}"/><span class="opacity-40 text-[10px]">次起</span></label>
            <select data-s="type" class="select select-xs select-bordered shrink-0">${tOpts}</select>
            <textarea data-s="value" rows="1" class="textarea textarea-xs textarea-bordered flex-1 leading-tight"${maxSay ? ` maxlength="${maxSay}"` : ""} placeholder="${_esc(hint)}">${_esc(st.value || "")}</textarea>
            <button data-s="del" class="btn btn-xs btn-ghost text-error/70">✕</button>`;
          row.querySelector('[data-s="step"]').addEventListener("change", (e) => { st.step = Math.max(1, Number(e.target.value) || 1); _save(); });
          row.querySelector('[data-s="type"]').addEventListener("change", (e) => {
            st.type = e.target.value;
            const ta = row.querySelector('[data-s="value"]'); if (ta) ta.placeholder = (types.find(t => t.value === st.type) || {}).hint || "";
            _save();
          });
          row.querySelector('[data-s="value"]').addEventListener("change", (e) => { st.value = e.target.value; _save(); });
          row.querySelector('[data-s="del"]').addEventListener("click", () => { arr.splice(si, 1); if (!arr.length) delete a.reactions[g]; _save(); renderSteps(); });
          stepsHost.appendChild(row);
        });
      };
      gSel.addEventListener("change", renderSteps);
      card.querySelector('[data-f="addstep"]').addEventListener("click", () => {
        const g = gSel.value;
        if (!a.reactions) a.reactions = {};
        if (!Array.isArray(a.reactions[g])) a.reactions[g] = [];
        const last = a.reactions[g][a.reactions[g].length - 1];
        a.reactions[g].push({ step: last ? (Number(last.step) || 1) + 1 : 1, type: types[0].value, value: "" });
        _save(); renderSteps();
      });
      card.querySelector('[data-f="name"]').addEventListener("change", (e) => { a.name = e.target.value.trim(); _save(); _renderRows(); });
      card.querySelector('[data-f="del"]').addEventListener("click", () => { const idx = _areas.indexOf(a); if (idx >= 0) _areas.splice(idx, 1); _save(); _renderRows(); _redraw(); });
      renderSteps();
      list.appendChild(card);
    });
  };
  // 导出/导入(凛倾:"需要有导出系统")
  $id("hm-export").addEventListener("click", () => {
    const data = JSON.stringify({ model: _model, kind: _kind, hitAreas: _areas }, null, 2);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([data], { type: "application/json" }));
    a.download = `hitareas_${_model}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });
  $id("hm-import").addEventListener("click", () => {
    const inp = document.createElement("input");
    inp.type = "file"; inp.accept = "application/json,.json";
    inp.addEventListener("change", async () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      try {
        const j = JSON.parse(await f.text());
        const arr = Array.isArray(j) ? j : (Array.isArray(j.hitAreas) ? j.hitAreas : null);
        if (!arr) throw new Error("文件里没有 hitAreas 数组");
        if (!(await beiluConfirm(`导入 ${arr.length} 个热区,替换当前形象现有 ${_areas.length} 个?`))) return;
        _areas = arr.filter(x => x && typeof x === "object");
        await _save(); _renderRows(); _redraw();
        $id("hm-status").textContent = "已导入";
      } catch (e2) { $id("hm-status").textContent = "导入失败: " + e2.message; }
    });
    inp.click();
  });
  window.addEventListener("resize", _redraw);
  _redraw();
}

// ── 接线(companion.mjs 调一次) ──
export function initHitEditor(opts) {
  if (opts && typeof opts.getCaps === "function") _caps = opts.getCaps;
  if (opts && typeof opts.getIpkNames === "function") _ipkNames = opts.getIpkNames;
  $id("hit-show")?.addEventListener("click", () => { _showOn = !_showOn; _drawPanelOverlay(_showOn); });
  $id("hit-draw")?.addEventListener("click", () => {
    if (!_model) { _status("先在\u201c桌宠形象\u201d选形象", true); return; }
    if (!_types().length) { _status("动作类型来自 beilu 后端(caps),当前不可达——不编造默认", true); return; }
    if (_kind === "live2d" && window.beiluLive2d && window.beiluLive2d.drawablesAt) _partPick();
    else _openModal(); // 图片包:直接进放大编辑器画形状
  });
  $id("hit-open-editor")?.addEventListener("click", () => _openModal());
  // 热区 say 的 web 侧反馈(桌面主场=气泡;web 用 toast)
  window.addEventListener("beilu:pet-hit-say", (e) => { const t = e && e.detail && e.detail.text; if (t) window._beiluToast?.(String(t), "info", 4000); });
}

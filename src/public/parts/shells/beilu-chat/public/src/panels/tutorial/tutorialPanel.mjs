// 教程/视觉小说 可视化编辑器 — beilu-chat 浮动窗
// 布局: 顶部(线路导航) | 左(对话列表) | 中(场景预览画布) | 右(属性面板)
// 参照 tuesday-js visual editor UX

import {
  startTutorial, listTutorials, loadTutorial,
  saveTutorial, deleteTutorial, listImagepacks, listSounds, downloadSounds,
  applyArtLayout, applyTutCSSVars, loadTutorialDefaults, TUT_DEFAULTS,
  previewTypeSound, listBlipPresets, soundUrl, resolveArtUrl,
  renderDialogForEdit, stopEditRender, isEditRender, syncEditVars,
  escTutHtml, SHOW_IF_RE,
} from "../../shared/tutorial/tutorialEngine.mjs";

const $ = id => document.getElementById(id);
let _inited = false;
let _cur = null;       // 当前教程JSON
let _packs = [];       // 可用图包(listImagepacks: [{name, expressions:{表情:[文件]}, default}])
let _selBlock = null;  // 当前Block名
let _selScene = 0;     // 当前场景索引
let _selDialog = 0;    // 当前对话索引
let _defaults = {};    // data/tutorials/_defaults.json 覆盖层(行为默认: art_default_pos/size 等)
let _sounds = [];      // 系统声音库文件列表(data/tutorials/sounds/)
let _saveTimer = null; // 自动保存debounce(凛倾: "拖动保存"=操作即持久, 不点保存钮)

// 新增立绘出厂位置/尺寸(出厂单点, _defaults.json 的 art_default_pos/art_default_size 可覆盖)
const NEW_ART_POS = ["25%", "0", "10%", "0"];
const NEW_ART_SIZE = ["40%", "auto"];
const _artDefaultPos = () => [...(Array.isArray(_defaults.art_default_pos) ? _defaults.art_default_pos : NEW_ART_POS)];
const _artDefaultSize = () => [...(Array.isArray(_defaults.art_default_size) ? _defaults.art_default_size : NEW_ART_SIZE)];

// ── 打开/关闭 ──

let _sndDlStarted = false; // 会话内只发一次(后端另有busy守卫+已存在跳过, 双幂等)

export async function openTutorialPanel() {
  _defaults = await loadTutorialDefaults().catch(() => ({}));
  let ov = $("tut-editor-overlay");
  if (!ov) { _createDOM(); ov = $("tut-editor-overlay"); }
  ov.classList.remove("hidden");
  if (!_inited) { _inited = true; _bindAll(); _refresh(); }
  if (_cur) _renderCanvas(); // 恢复编辑态舞台
  // 音效库自动补齐(凛倾批注7"音效库是不是之后才下载": 効果音ラボ许可禁随仓库分发,
  // 打开编辑器时后台下载到用户层 data/tutorials/sounds/, 完成后刷新声音下拉)
  if (!_sndDlStarted) {
    _sndDlStarted = true;
    downloadSounds().then(async (r) => {
      if (r?.downloaded > 0) {
        _sounds = await listSounds().catch(() => _sounds) || _sounds;
        _renderAll();
        window._beiluToast?.(`音效库已补齐 ${r.downloaded} 个文件`, "success");
      }
    }).catch(e => console.debug("[tut-editor] sounds-download:", e?.message));
  }
}
export function closeTutorialPanel() {
  _unbindStageEditing();
  stopEditRender();
  $("tut-editor-overlay")?.classList.add("hidden");
}
export function toggleTutorialPanel() {
  const ov = $("tut-editor-overlay");
  if (!ov || ov.classList.contains("hidden")) openTutorialPanel(); else closeTutorialPanel();
}

// ── DOM 创建(完整编辑器) ──

function _createDOM() {
  const div = document.createElement("div");
  div.id = "tut-editor-overlay";
  div.className = "hidden";
  div.innerHTML = `
<style>
/* ══ 全屏直编模式(凛倾原话MSG#15"中间是界面和拖动"/MSG#17"在这些平面上覆盖一次"):
   容器零遮挡零背景 — 中央=真实chat界面(教程层#tut-overlay由engine渲染其上, 编辑交互绑其元素),
   工具=三个贴边可折叠浮条(顶:工具+线路 / 左:场景对话 / 右:属性)。z序在#tut-overlay(99999)之上 ══ */
#tut-editor-overlay { position:fixed; inset:0; z-index:100001; pointer-events:none; }
#tut-editor-overlay.hidden { display:none !important; }
#tut-editor-win { display:contents; } /* 兼容既有 _syncPreviewVars 对win注入CSS变量: 改注到overlay自身 */

.te-dock { position:fixed; pointer-events:auto; background:color-mix(in oklch, var(--color-base-100) 96%, transparent); border:1px solid var(--color-base-300);
  box-shadow:0 6px 24px rgba(0,0,0,.25); transition:transform .18s ease; }
.te-dock-handle { position:absolute; pointer-events:auto; background:var(--color-warning); color:var(--color-warning-content, var(--color-base-100));
  font-size:10px; cursor:pointer; user-select:none; display:flex; align-items:center; justify-content:center; }

/* 顶条: 工具+线路 */
#te-top-dock { top:0; left:50%; transform:translateX(-50%); max-width:96vw; border-radius:0 0 12px 12px; border-top:none; }
#te-top-dock.folded { transform:translate(-50%, -100%); }
#te-top-dock .te-dock-handle { left:50%; bottom:-18px; transform:translateX(-50%); width:56px; height:18px; border-radius:0 0 8px 8px; }
.te-topbar { display:flex; align-items:center; gap:6px; padding:6px 12px; flex-wrap:wrap; }
.te-topbar .btn { font-size:12px; }
.te-block-nav { display:flex; gap:3px; flex-wrap:wrap; max-width:40vw; }
.te-block-btn { padding:3px 10px; border-radius:6px; border:1px solid var(--color-base-300); background:transparent; cursor:pointer; font-size:11px; transition:all .12s; }
.te-block-btn:hover { border-color:var(--color-warning); }
.te-block-btn.active { background:color-mix(in oklch, var(--color-warning) 15%, transparent); border-color:var(--color-warning); color:var(--color-warning); font-weight:600; }

/* 左条: 场景+对话列表 */
#te-left-dock { left:0; top:12vh; height:72vh; width:clamp(160px, 15vw, 240px); border-radius:0 12px 12px 0; border-left:none; display:flex; flex-direction:column; }
#te-left-dock.folded { transform:translateX(-100%); }
#te-left-dock .te-dock-handle { right:-18px; top:50%; transform:translateY(-50%); width:18px; height:56px; border-radius:0 8px 8px 0; writing-mode:vertical-rl; }

/* 右条: 属性 */
#te-right-dock { right:0; top:8vh; height:84vh; width:clamp(220px, 20vw, 320px); border-radius:12px 0 0 12px; border-right:none; display:flex; flex-direction:column; }
#te-right-dock.folded { transform:translateX(100%); }
#te-right-dock .te-dock-handle { left:-18px; top:50%; transform:translateY(-50%); width:18px; height:56px; border-radius:8px 0 0 8px; writing-mode:vertical-rl; }

/* 左栏: 对话列表 */
.te-left { width:200px; flex-shrink:0; border-right:1px solid var(--color-base-300); display:flex; flex-direction:column; overflow:hidden; background:color-mix(in oklch, var(--color-base-200) 30%, transparent); }
.te-left-header { padding:6px 10px; font-size:11px; font-weight:700; opacity:.5; border-bottom:1px solid color-mix(in oklch, var(--color-base-300) 50%, transparent); display:flex; align-items:center; gap:4px; }
.te-left-list { flex:1; overflow-y:auto; padding:4px; }
.te-dlg-item { padding:6px 8px; border-radius:6px; cursor:pointer; margin-bottom:2px; font-size:11px; border:1px solid transparent; transition:all .1s; display:flex; gap:6px; align-items:flex-start; }
.te-dlg-item:hover { background:var(--color-base-200); }
.te-dlg-item.active { background:color-mix(in oklch, var(--color-primary) 10%, transparent); border-color:color-mix(in oklch, var(--color-primary) 40%, transparent); }
.te-dlg-num { width:18px; height:18px; border-radius:50%; background:var(--color-base-300); display:flex; align-items:center; justify-content:center; font-size:9px; font-weight:700; flex-shrink:0; }
.te-dlg-item.active .te-dlg-num { background:var(--color-primary); color:var(--color-primary-content); }
.te-dlg-preview { flex:1; overflow:hidden; }
.te-dlg-name { font-weight:600; font-size:10px; color:var(--color-warning); }
.te-dlg-text { opacity:.6; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.te-dlg-badges { display:flex; gap:2px; margin-top:2px; }
.te-dlg-badges span { font-size:9px; padding:0 4px; border-radius:3px; background:color-mix(in oklch, var(--color-base-300) 50%, transparent); }

/* ══ 舞台编辑控件: 挂在 engine 渲染的真实教程层(#tut-overlay)元素上 ══ */
/* 手柄/工具条编辑态常显(凛倾0715: "角色图形没办法调整大小"——选中才显示=发现不了), 悬停提亮。
   必须scope到.tut-editing: 本style注入document后常驻, 不scope则真播教程时立绘也带虚线框 */
#tut-overlay.tut-editing .tut-art { outline:1.5px dashed color-mix(in oklch, var(--color-warning) 45%, transparent); outline-offset:2px; }
#tut-overlay.tut-editing .tut-art:hover, #tut-overlay.tut-editing .tut-art.te-selected { outline:2px dashed var(--color-warning); }
.te-art-resize { position:absolute; right:-8px; bottom:-8px; width:16px; height:16px; border-radius:50%;
  background:var(--color-warning); border:2px solid var(--color-base-100); cursor:nwse-resize; z-index:2; pointer-events:auto; }
.te-art-tools { position:absolute; top:-30px; left:0; display:flex; gap:3px; z-index:3; pointer-events:auto; }
#tut-name[contenteditable]:empty::before, #tut-text[contenteditable]:empty::before {
  content:attr(data-ph); opacity:.35; pointer-events:none; }
#tut-name[contenteditable]:focus, #tut-text[contenteditable]:focus { outline:1px dashed var(--color-warning); outline-offset:2px; }

/* 右条内部 */
.te-right-header { padding:6px 10px; font-size:11px; font-weight:700; opacity:.5; border-bottom:1px solid color-mix(in oklch, var(--color-base-300) 50%, transparent); }
.te-right-body { flex:1; overflow-y:auto; padding:8px; }
.te-prop-section { margin-bottom:12px; }
.te-prop-title { font-size:10px; font-weight:700; opacity:.4; text-transform:uppercase; margin-bottom:4px; display:flex; align-items:center; gap:4px; }
.te-prop-title button { font-size:10px; }
.te-prop-row { margin-bottom:4px; }
.te-prop-row label { display:block; font-size:10px; opacity:.5; margin-bottom:1px; }
.te-prop-row input, .te-prop-row select, .te-prop-row textarea { width:100%; }

/* 选项编辑卡片 */
.te-choice-card { background:color-mix(in oklch, var(--color-base-200) 50%, transparent); border:1px solid var(--color-base-300); border-radius:6px; padding:6px; margin-bottom:4px; }
.te-choice-card .te-choice-header { display:flex; align-items:center; gap:4px; margin-bottom:4px; }
.te-choice-card .te-choice-header input { flex:1; }
.te-choice-trigger { font-size:10px; opacity:.6; padding:4px 0; border-top:1px solid color-mix(in oklch, var(--color-base-300) 30%, transparent); margin-top:4px; }

/* 对话框拖动手柄(挂#tut-text-panel) / 上下文菜单 */
.te-dlg-grip { position:absolute; top:-10px; left:50%; transform:translateX(-50%); width:56px; height:16px;
  border-radius:8px; background:var(--color-base-300); cursor:move; opacity:.5; transition:opacity .12s; pointer-events:auto; }
.te-dlg-grip:hover { opacity:1; background:var(--color-warning); }
.te-ctx-menu { position:fixed; z-index:100002; min-width:150px; background:var(--color-base-100);
  border:1px solid var(--color-base-300); border-radius:8px; box-shadow:0 8px 24px rgba(0,0,0,.35); padding:3px; }
.te-ctx-menu button { display:flex; align-items:center; gap:6px; width:100%; padding:6px 10px; border-radius:5px;
  font-size:12px; text-align:left; background:transparent; border:none; cursor:pointer; }
.te-ctx-menu button:hover { background:var(--color-base-200); }
.te-ctx-menu button.danger:hover { background:color-mix(in oklch, var(--color-error) 15%, transparent); color:var(--color-error); }
.te-art-tools button { padding:2px 8px; border-radius:5px; font-size:10px; background:var(--color-base-100);
  border:1px solid var(--color-base-300); cursor:pointer; white-space:nowrap; }
.te-art-tools button:hover { border-color:var(--color-warning); }
.te-choice-add { padding:var(--tut-choice-pad); border-radius:var(--tut-choice-radius); border:1px dashed color-mix(in oklch, var(--color-base-content) 30%, transparent);
  background:transparent; color:color-mix(in oklch, var(--color-base-content) 40%, transparent); font-size:var(--tut-choice-fs); cursor:pointer; }
.te-choice-add:hover { border-color:var(--color-warning); color:var(--color-warning); }

/* 搜索结果下拉(fixed, 顶条下方) */
#te-search-results { position:fixed; top:44px; right:16px; z-index:100002; width:320px; max-height:50vh; overflow-y:auto;
  pointer-events:auto; background:var(--color-base-100); border:1px solid var(--color-base-300); border-radius:8px; box-shadow:0 8px 24px rgba(0,0,0,.3); padding:4px; }
#te-search-results.hidden { display:none; }
.te-sr-item { padding:5px 8px; border-radius:5px; cursor:pointer; font-size:11px; }
.te-sr-item:hover { background:var(--color-base-200); }
.te-sr-loc { font-size:9px; opacity:.5; }

/* 流程图=局部浮窗(不遮全屏, 界面其余照常可点; ×/ESC/再点流程图按钮关闭) */
#te-flow-wrap { position:fixed; left:50%; top:52px; transform:translateX(-50%); width:min(80vw, 900px); height:min(64vh, 600px);
  overflow:auto; display:none; background:color-mix(in oklch, var(--color-base-100) 97%, transparent); border:1px solid var(--color-base-300); border-radius:12px;
  box-shadow:0 12px 40px rgba(0,0,0,.35); pointer-events:auto; z-index:100000; }
#te-flow-wrap.active { display:block; }
#te-flow-bar { position:sticky; top:0; z-index:3; display:flex; align-items:center; gap:6px; padding:4px 10px;
  background:color-mix(in oklch, var(--color-base-100) 97%, transparent); border-bottom:1px solid color-mix(in oklch, var(--color-base-300) 60%, transparent); }
.te-flow-legend { font-size:10px; opacity:.65; display:flex; align-items:center; gap:4px; flex-wrap:wrap; }
.te-flow-legend i { display:inline-block; width:14px; height:9px; border:1.5px solid var(--color-base-300); border-radius:3px; }
#te-flow-svg { position:absolute; inset:0; width:100%; height:100%; pointer-events:none; }
.te-flow-node { position:absolute; min-width:120px; padding:8px 12px; border-radius:8px; cursor:move;
  background:var(--color-base-100); border:1.5px solid var(--color-base-300); font-size:11px; user-select:none; }
.te-flow-node.launch { border-color:var(--color-success); }
.te-flow-node.unreach { border-color:var(--color-error); border-style:dashed; }
.te-flow-node.active { border-color:var(--color-warning); box-shadow:0 0 0 2px color-mix(in oklch, var(--color-warning) 30%, transparent); }
.te-flow-node .fn-title { font-weight:700; margin-bottom:2px; }
.te-flow-node .fn-meta { font-size:9px; opacity:.5; }
.te-flow-node .fn-warn { font-size:9px; color:var(--color-error); }
.te-flow-edge { stroke:var(--color-warning); stroke-width:1.5; fill:none; opacity:.7; }
.te-flow-elabel { font-size:10px; fill:var(--color-warning); paint-order:stroke; stroke:var(--color-base-100); stroke-width:3px; }
</style>

<div id="tut-editor-win">
  <!-- 顶条: 工具+线路+插入(可折叠) -->
  <div id="te-top-dock" class="te-dock">
    <div class="te-topbar">
      <button id="te-close" class="btn btn-xs btn-ghost" title="退出编辑">✕</button>
      <button id="te-new" class="btn btn-xs btn-primary">新建</button>
      <select id="te-tutorial-sel" class="select select-xs select-bordered w-36">
        <option value="">选择教程...</option>
      </select>
      <button id="te-save" class="btn btn-xs btn-success" disabled>保存</button>
      <span id="te-save-status" class="text-[10px] opacity-60"></span>
      <button id="te-play" class="btn btn-xs btn-warning" disabled>预览</button>
      <button id="te-record" class="btn btn-xs btn-outline btn-error" disabled title="录制: 在页面上点一遍操作, 每次点击自动生成一步引导">⏺录制</button>
      <button id="te-del" class="btn btn-xs btn-error btn-outline" disabled>删除</button>
      <span class="opacity-30 text-xs">|</span>
      <button id="ti-dialog" class="btn btn-xs btn-outline" title="在当前对话后插入新对话">＋对话</button>
      <button id="ti-art" class="btn btn-xs btn-outline" title="给当前对话加角色立绘(从图包选)">＋角色</button>
      <button id="ti-choice" class="btn btn-xs btn-outline" title="给当前对话加选项">＋选项</button>
      <button id="ti-pick" class="btn btn-xs btn-outline" title="设置引导点击目标(页面上拾取)">＋引导</button>
      <span class="opacity-30 text-xs">|</span>
      <div class="te-block-nav" id="te-blocks"></div>
      <button id="te-issues" class="btn btn-xs btn-ghost" disabled title="链路检查: 断链跳转/不可达线路">✓链路</button>
      <button id="te-flow" class="btn btn-xs btn-ghost" disabled title="线路流程图: 选项/跳转连线一目了然">流程图</button>
      <button id="te-sounds" class="btn btn-xs btn-ghost" title="声音库浏览: 试听/选用">🔊</button>
      <input id="te-search" class="input input-xs input-bordered w-24" placeholder="搜索" />
      <label class="btn btn-xs btn-ghost">导入<input type="file" id="te-import" accept=".json" class="hidden" /></label>
      <button id="te-export" class="btn btn-xs btn-ghost" disabled>导出</button>
    </div>
    <div class="te-dock-handle" data-fold="te-top-dock" title="收起/展开">⌃</div>
  </div>
  <div id="te-search-results" class="hidden"></div>

  <!-- 左条: 场景+对话列表(可折叠) -->
  <div id="te-left-dock" class="te-dock">
    <div class="te-left-header">
      <span>场景 <span id="te-scene-label"></span></span>
      <span class="flex-1"></span>
      <button id="te-prev-scene" class="btn btn-xs btn-ghost" title="上一场景">&larr;</button>
      <button id="te-next-scene" class="btn btn-xs btn-ghost" title="下一场景">&rarr;</button>
      <button id="te-add-scene" class="btn btn-xs btn-ghost" title="添加场景">+</button>
      <button id="te-del-scene" class="btn btn-xs btn-ghost text-error" title="删除本场景">×</button>
    </div>
    <div class="te-left-list" id="te-dialog-list"></div>
    <div style="padding:4px; border-top:1px solid color-mix(in oklch, var(--color-base-300) 30%, transparent); display:flex; flex-direction:column; gap:3px;">
      <button id="te-add-dialog" class="btn btn-xs btn-ghost w-full">+ 添加对话</button>
      <label class="text-[10px] opacity-60 px-1">场景背景图<input id="te-bg-img" class="input input-xs input-bordered w-full" placeholder="URL, 空=界面为背景" /></label>
      <label class="text-[10px] opacity-60 px-1">场景音乐<select id="te-bg-music-lib" class="select select-xs select-bordered w-full"><option value="">无</option></select></label>
    </div>
    <div class="te-dock-handle" data-fold="te-left-dock" title="收起/展开">场景</div>
  </div>

  <!-- 右条: 属性(可折叠) -->
  <div id="te-right-dock" class="te-dock">
    <div class="te-right-header">属性</div>
    <div class="te-right-body" id="te-props"></div>
    <div class="te-dock-handle" data-fold="te-right-dock" title="收起/展开">属性</div>
  </div>

  <!-- 流程图浮窗 -->
  <div id="te-flow-wrap">
    <div id="te-flow-bar">
      <span class="te-flow-legend"><i style="border-color:var(--color-success)"></i>起点 <i style="border-color:var(--color-error);border-style:dashed"></i>不可达 · 连线标注⑂=选项文字 · 单击节点=进入编辑 · 右键节点=改名/删除/设起点 · 拖动=摆放</span>
      <span style="flex:1"></span>
      <button id="te-flow-auto" class="btn btn-xs btn-ghost" title="按线路跳转关系自动分层排列">自动排列</button>
      <button id="te-flow-close" class="btn btn-xs btn-ghost">✕ 关闭</button>
    </div>
    <svg id="te-flow-svg"></svg>
    <div id="te-flow-nodes"></div>
  </div>
</div>`;
  document.body.appendChild(div);
  // 折叠把手
  div.querySelectorAll(".te-dock-handle").forEach(h => h.addEventListener("click", () => {
    document.getElementById(h.dataset.fold)?.classList.toggle("folded");
  }));
  _syncPreviewVars();
}

// 预览画布视觉变量注入: engine applyTutCSSVars 同一份映射(TUT_DEFAULTS + 当前教程text_panel覆盖)
// → 预览=运行时同源; 教程未加载时纯默认
function _syncPreviewVars() {
  const win = $("tut-editor-win");
  if (win) applyTutCSSVars(_cur?.parameters, win.style);
  syncEditVars(_cur?.parameters); // 舞台overlay同步(engine内部保持pet-settings优先级链)
  _touch();
}

// ── 自动保存: 任何编辑后1.5s静默即落盘(凛倾"拖动保存"); 渲染入口=编辑必经点, 幂等PUT ──
function _touch() {
  if (!_cur?.id) return;
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(async () => {
    const r = await saveTutorial(_cur).catch(e => { console.warn("[tut-editor] save:", e?.message); return null; });
    const el = $("te-save-status");
    if (el) {
      el.textContent = r?.success ? "已自动保存" : "自动保存失败(点击重试)";
      el.classList.toggle("text-error", !r?.success);
      if (r?.success) {
        $("te-del") && ($("te-del").disabled = false);
        // 新建教程首次落盘后"选择教程"下拉才有它: 未反选时补刷列表(已反选不重复刷, 防闪烁)
        if ($("te-tutorial-sel")?.value !== _cur?.id) _refresh();
        setTimeout(() => { if (el.textContent === "已自动保存") el.textContent = ""; }, 2000);
      }
      else { el.style.cursor = "pointer"; el.onclick = () => { el.onclick = null; el.style.cursor = ""; _touch(); }; }
    }
  }, Number(_defaults?.editor_autosave_delay) || 1500);
}

// ── 事件绑定 ──

function _bindAll() {
  $("te-close")?.addEventListener("click", closeTutorialPanel);
  $("te-new")?.addEventListener("click", _newTut);
  $("te-save")?.addEventListener("click", _save);
  $("te-play")?.addEventListener("click", () => {
    if (!_cur) return;
    // 预览=真运行时: 退编辑态(去contenteditable/grip/手柄) → startTutorial → 结束回编辑态
    _unbindStageEditing();
    stopEditRender();
    $("tut-editor-overlay")?.classList.add("hidden"); // 浮条让位, 纯用户视角
    startTutorial(_cur, { onEnd: () => { $("tut-editor-overlay")?.classList.remove("hidden"); _renderCanvas(); } });
  });
  $("te-record")?.addEventListener("click", _startRecord);
  $("te-sounds")?.addEventListener("click", (e) => { e.stopPropagation(); _openSoundBrowser(); });
  $("te-del")?.addEventListener("click", _del);
  $("te-export")?.addEventListener("click", _export);
  $("te-import")?.addEventListener("change", _import);
  $("te-issues")?.addEventListener("click", (e) => { e.stopPropagation(); _openIssuesMenu(); });
  $("te-flow-auto")?.addEventListener("click", () => {
    if (_cur?.parameters?.editor_pos) { delete _cur.parameters.editor_pos; _touch(); }
    _renderFlow();
  });
  $("te-flow-close")?.addEventListener("click", () => { if (_flowOn) _toggleFlow(); });
  $("te-tutorial-sel")?.addEventListener("change", (e) => { if (e.target.value) _load(e.target.value); });
  $("te-prev-scene")?.addEventListener("click", () => { if (_selScene > 0) { _selScene--; _selDialog = 0; _renderAll(); } });
  $("te-next-scene")?.addEventListener("click", () => {
    const scenes = _cur?.[_selBlock];
    if (scenes && _selScene < scenes.length - 1) { _selScene++; _selDialog = 0; _renderAll(); }
  });
  $("te-add-scene")?.addEventListener("click", () => {
    if (!_cur || !_selBlock) return;
    _cur[_selBlock].push({ dialogs: [{ text: "" }] });
    _selScene = _cur[_selBlock].length - 1; _selDialog = 0; _renderAll();
  });
  $("te-add-dialog")?.addEventListener("click", () => {
    const scene = _getScene(); if (!scene) return;
    if (!scene.dialogs) scene.dialogs = [];
    scene.dialogs.push({ text: "" });
    _selDialog = scene.dialogs.length - 1; _renderAll();
  });
  $("te-del-scene")?.addEventListener("click", () => {
    if (!_cur || !_selBlock) return;
    const scenes = _cur[_selBlock]; if (!scenes || scenes.length <= 1) return;
    scenes.splice(_selScene, 1);
    if (_selScene >= scenes.length) _selScene = scenes.length - 1;
    _selDialog = 0; _renderAll();
  });
  $("te-bg-img")?.addEventListener("change", (e) => { const s = _getScene(); if (s) { s.background_image = e.target.value; _renderCanvas(); } });
  // 场景音乐=系统声音库下拉(data/tutorials/sounds/, 全局存储); 值存引擎可播的URL
  $("te-bg-music-lib")?.addEventListener("change", (e) => {
    const s = _getScene(); if (!s) return;
    if (e.target.value) s.background_music = soundUrl(e.target.value);
    else delete s.background_music;
    _touch();
  });

  // (画布直接编辑绑定已移至 _bindStageOnce: 交互挂 engine 渲染的真实教程层元素)

  // ── 插入工具条: 一键作用当前对话 ──
  $("ti-dialog")?.addEventListener("click", () => {
    const scene = _getScene(); if (!scene) return;
    if (!scene.dialogs) scene.dialogs = [];
    scene.dialogs.splice(_selDialog + 1, 0, { text: "" });
    _selDialog = Math.min(_selDialog + 1, scene.dialogs.length - 1);
    _renderAll();
    setTimeout(() => document.getElementById("tut-text")?.focus(), 150); // 舞台渲染后聚焦直打
  });
  $("ti-art")?.addEventListener("click", () => {
    const d = _getDialog(); if (!d) return;
    if (!d.art) d.art = [];
    const a = { url: "", size: _artDefaultSize(), position: _artDefaultPos() };
    d.art.push(a);
    _artImagePicker(a); // 立刻选图, 选完落画布
  });
  $("ti-choice")?.addEventListener("click", () => { const d = _getDialog(); if (d) _addChoice(d); });
  $("ti-pick")?.addEventListener("click", () => {
    const d = _getDialog(); if (!d) return;
    _startElementPick((sel) => { d.await_click = sel; _renderProps(); _renderDialogList(); });
  });

  // 流程图切换 + 搜索
  $("te-flow")?.addEventListener("click", _toggleFlow);
  $("te-search")?.addEventListener("input", (e) => _doSearch(e.target.value));
  $("te-search")?.addEventListener("focus", (e) => _doSearch(e.target.value));
  // Ctrl+F=聚焦搜索(编辑器开着时接管, document级捕获; div不聚焦收不到keydown)
  document.addEventListener("keydown", (e) => {
    const ov = $("tut-editor-overlay");
    if (!ov || ov.classList.contains("hidden")) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") { e.preventDefault(); $("te-search")?.focus(); }
    if (e.key === "Escape") $("te-search-results")?.classList.add("hidden");
  });
  // 点击面板他处收起搜索结果
  $("tut-editor-overlay")?.addEventListener("click", (e) => {
    if (!e.target.closest("#te-search") && !e.target.closest("#te-search-results")) {
      $("te-search-results")?.classList.add("hidden");
    }
  });
}

// ── 数据操作 ──

async function _refresh() {
  let _fetchFailed = false;
  _packs = await listImagepacks().catch(e => { console.debug("[tut-editor] imagepacks:", e?.message); _fetchFailed = true; return []; }) || [];
  _sounds = await listSounds().catch(e => { console.debug("[tut-editor] sounds:", e?.message); _fetchFailed = true; return []; }) || [];
  const tuts = await listTutorials().catch(e => { console.debug("[tut-editor] tutorials:", e?.message); _fetchFailed = true; return []; }) || [];
  if (_fetchFailed) window._beiluToast?.("教程后端未响应(需重启?)", "warning");
  const sel = $("te-tutorial-sel"); if (!sel) return;
  sel.innerHTML = '<option value="">选择教程...</option>' + tuts.map(t =>
    `<option value="${_e(t.id)}" ${_cur?.id === t.id ? 'selected' : ''}>${_e(t.title || t.id)} (${t.stepCount}步)</option>`
  ).join("");
}

async function _load(id) {
  _cur = await loadTutorial(id); if (!_cur) return;
  const blocks = _getBlocks();
  _selBlock = _cur.parameters?.launch_story || blocks[0] || null;
  _selScene = 0; _selDialog = 0;
  _enableBtns(true); _renderAll(); _refresh();
}

function _newTut() {
  _cur = {
    id: "tut_" + Date.now().toString(36), title: "新教程", version: 1,
    parameters: { launch_story: "main", text_panel: {}, variables: {}, characters: {} },
    main: [{ dialogs: [{ text: "" }] }], // 空文本=画布占位符引导"点击输入对话文字…"
  };
  _selBlock = "main"; _selScene = 0; _selDialog = 0;
  _enableBtns(true); $("te-del").disabled = true;
  _renderAll(); _refresh();
}

async function _save() {
  if (!_cur) return;
  const r = await saveTutorial(_cur);
  if (r?.success) { window._beiluToast?.("已保存", "success"); $("te-del").disabled = false; _refresh(); }
  else window._beiluToast?.("保存失败", "error");
}

async function _del() {
  if (!_cur) return;
  const { beiluConfirm } = await import("../../shared/widgets/beiluDialog.mjs");
  if (!await beiluConfirm(`删除「${_cur.title || _cur.id}」？`)) return;
  await deleteTutorial(_cur.id); _cur = null; _enableBtns(false);
  _selBlock = null; _renderAll(); _refresh();
}

function _export() {
  if (!_cur) return;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(_cur, null, 2)], { type: "application/json" }));
  a.download = (_cur.id || "tutorial") + ".json"; a.click();
}

async function _import(e) {
  const f = e.target.files?.[0]; if (!f) return;
  try {
    _cur = JSON.parse(await f.text());
    const blocks = _getBlocks();
    _selBlock = _cur.parameters?.launch_story || blocks[0] || null;
    _selScene = 0; _selDialog = 0;
    _enableBtns(true); _renderAll(); _refresh();
  } catch (err) { window._beiluToast?.("导入失败: " + err.message, "error"); }
  e.target.value = "";
}

// ══ 线路(Block)管理: 选项驱动模型(凛倾0715: "创建选项,然后增加就是选择选项") ══
// 新线路只从"去向"创建 — 选项/跳转下拉里的"＋新建", 或选项菜单"创建点击后的对话";
// 没有独立的凭空建线入口。删除/重命名带全量引用清理(引用清单=_forEachRef 单源)。

const RESERVED_KEYS = ["parameters", "id", "title", "version", "character", "blocks"];

/** 遍历教程内所有指向线路的引用点(跳转边唯一权威清单: 流程图/链路校验/删除/重命名共用)
 *  cb({ kind, label, text?, block?, si?, di?, get, set }) — block为空=教程级引用(帮助点/自动触发) */
function _forEachRef(cb) {
  if (!_cur) return;
  for (const b of _getBlocks()) {
    (_cur[b] || []).forEach((scene, si) => {
      (scene?.dialogs || []).forEach((d, di) => {
        if (d.go_to) cb({ kind: "go_to", label: "跳转", block: b, si, di,
          get: () => d.go_to, set: v => { if (v) d.go_to = v; else delete d.go_to; } });
        if (Array.isArray(d.timer) && d.timer[1]) cb({ kind: "timer", label: "定时跳转", block: b, si, di,
          get: () => d.timer?.[1], set: v => { if (v) d.timer[1] = v; else delete d.timer; } });
        if (typeof d.await_click === "object" && d.await_click?.go_to) cb({ kind: "await", label: "引导点击跳转", block: b, si, di,
          get: () => d.await_click.go_to, set: v => { if (v) d.await_click.go_to = v; else delete d.await_click.go_to; } });
        (d.choice || []).forEach((c, ci) => { if (c.go_to) cb({ kind: "choice", label: `选项「${c.text || ""}」`, text: c.text, block: b, si, di, ci,
          get: () => c.go_to, set: v => { if (v) c.go_to = v; else delete c.go_to; } }); });
      });
    });
  }
  (_cur.parameters?.help_points || []).forEach((h, i) => { if (h.story) cb({ kind: "help", label: `帮助点${i + 1}「${h.label || h.selector || ""}」`,
    get: () => h.story, set: v => { h.story = v || ""; } }); });
  const ats = _cur.parameters?.auto_trigger;
  (Array.isArray(ats) ? ats : ats ? [ats] : []).forEach((a, i) => { if (a?.story) cb({ kind: "auto", label: `自动触发${i + 1}`,
    get: () => a.story, set: v => { a.story = v || ""; } }); });
  const db = _cur.parameters?.desk_button;
  if (db?.story) cb({ kind: "desk", label: "桌宠教程按钮",
    get: () => db.story, set: v => { db.story = v || ""; } });
}

/** go_to值→目标线路名; tue_go/空=无; "block,scene,dialog"三元组取首段(engine._parseGoTo同构) */
function _refBlockOf(v) {
  if (!v || typeof v !== "string" || v === "tue_go") return null;
  return v.includes(",") ? v.split(",")[0].trim() : v;
}
const _refRetarget = (v, nu) => v.includes(",") ? [nu, ...v.split(",").slice(1)].join(",") : nu;

/** 重命名线路: 键序保持 + 全部引用/起点/editor_pos 跟随(Twine同款: 改名自动更新所有指向链接) */
function _renameBlock(oldName, newName) {
  const rebuilt = {};
  for (const [k, v] of Object.entries(_cur)) rebuilt[k === oldName ? newName : k] = v;
  _cur = rebuilt;
  _forEachRef(r => { const v = r.get(); if (_refBlockOf(v) === oldName) r.set(_refRetarget(v, newName)); });
  if (_cur.parameters?.launch_story === oldName) _cur.parameters.launch_story = newName;
  const ep = _cur.parameters?.editor_pos;
  if (ep?.[oldName]) { ep[newName] = ep[oldName]; delete ep[oldName]; }
  if (_selBlock === oldName) _selBlock = newName;
}

/** 删除线路: 先数清指向它的引用并告知, 确认后清引用(选项退化为"继续")再删块; 起点被删=移交首块 */
async function _deleteBlock(name) {
  if (!_cur) return;
  if (_getBlocks().length <= 1) { window._beiluToast?.("至少保留一条线路", "warning"); return; }
  const refs = [];
  _forEachRef(r => { if (_refBlockOf(r.get()) === name) refs.push(r); });
  const { beiluConfirm } = await import("../../shared/widgets/beiluDialog.mjs");
  const msg = refs.length
    ? `删除线路「${name}」？\n有 ${refs.length} 处指向它: ${refs.slice(0, 4).map(r => r.label).join("、")}${refs.length > 4 ? "…" : ""}\n删除后这些跳转会被清除(选项变为"继续")。`
    : `删除线路「${name}」？(没有跳转指向它)`;
  if (!await beiluConfirm(msg)) return;
  refs.forEach(r => r.set(null));
  delete _cur[name];
  if (_cur.parameters?.editor_pos) delete _cur.parameters.editor_pos[name];
  const rest = _getBlocks();
  if (_cur.parameters?.launch_story === name) _cur.parameters.launch_story = rest[0];
  if (_selBlock === name) { _selBlock = _cur.parameters?.launch_story || rest[0]; _selScene = 0; _selDialog = 0; }
  _touch(); _renderAll();
  if (_flowOn) _renderFlow();
}

/** 新建线路(带名字校验); 供"＋新建线路/分支线"下拉项调用 */
async function _newLineViaPrompt(defaultName) {
  const { beiluPrompt } = await import("../../shared/widgets/beiluDialog.mjs");
  const n = ((await beiluPrompt("新线路名:", defaultName || "")) || "").trim();
  if (!n) return null;
  if (RESERVED_KEYS.includes(n)) { window._beiluToast?.("该名称是保留字", "warning"); return null; }
  if (_cur[n] !== undefined) { window._beiluToast?.("已存在同名线路", "warning"); return null; }
  _cur[n] = [{ dialogs: [{ text: "" }] }];
  return n;
}

/** 线路菜单(顶栏block按钮/流程图节点共用入口): 重命名/设为起点/删除 */
function _blockMenu(b, anchorEl) {
  const isLaunch = _cur?.parameters?.launch_story === b;
  const m = _openCtxMenu(anchorEl, [
    ["rename", "✎ 重命名线路"],
    ["launch", isLaunch ? "✓ 已是起点线路" : "▶ 设为起点线路"],
    ["del", "× 删除线路", true],
  ]);
  m.querySelector('[data-k="rename"]').addEventListener("click", async () => {
    _closeCtxMenu();
    const { beiluPrompt } = await import("../../shared/widgets/beiluDialog.mjs");
    const n = ((await beiluPrompt(`线路「${b}」改名为:`, b)) || "").trim();
    if (!n || n === b) return;
    if (RESERVED_KEYS.includes(n)) { window._beiluToast?.("该名称是保留字", "warning"); return; }
    if (_cur[n] !== undefined) { window._beiluToast?.("已存在同名线路", "warning"); return; }
    _renameBlock(b, n);
    _touch(); _renderAll();
    if (_flowOn) _renderFlow();
  });
  m.querySelector('[data-k="launch"]').addEventListener("click", () => {
    _closeCtxMenu();
    if (!_cur.parameters) _cur.parameters = {};
    _cur.parameters.launch_story = b;
    _touch(); _renderAll();
    if (_flowOn) _renderFlow();
  });
  m.querySelector('[data-k="del"]').addEventListener("click", () => { _closeCtxMenu(); _deleteBlock(b); });
}

// ── 链路校验: 断链跳转(目标线路不存在) + 不可达线路(无任何入口指向) ──
// 入口=起点launch_story + 帮助点story + 自动触发story; 引用清单=_forEachRef同源

function _reachableSet() {
  const blocks = new Set(_getBlocks());
  const launch = _cur?.parameters?.launch_story;
  const edges = {}; const roots = [];
  if (launch && blocks.has(launch)) roots.push(launch);
  _forEachRef(r => {
    const t = _refBlockOf(r.get());
    if (!t || !blocks.has(t)) return;
    if (r.block) (edges[r.block] ??= new Set()).add(t);
    else roots.push(t); // 帮助点/自动触发=独立入口
  });
  const reach = new Set(roots); const q = [...roots];
  while (q.length) { const b = q.pop(); for (const t of edges[b] || []) if (!reach.has(t)) { reach.add(t); q.push(t); } }
  return reach;
}

function _validateTut() {
  const issues = [];
  if (!_cur) return issues;
  const blocks = new Set(_getBlocks());
  const launch = _cur.parameters?.launch_story;
  if (!launch) issues.push({ msg: "未设置起点线路(launch_story)" });
  else if (!blocks.has(launch)) issues.push({ msg: `起点线路「${launch}」不存在` });
  _forEachRef(r => {
    const t = _refBlockOf(r.get());
    if (t && !blocks.has(t)) issues.push({
      msg: `${r.block ? `[${r.block} 场景${(r.si ?? 0) + 1} 对话${r.di ?? 0}] ` : ""}${r.label} → 指向不存在的线路「${t}」`,
      block: r.block, si: r.si, di: r.di,
    });
  });
  if (launch && blocks.has(launch)) {
    const reach = _reachableSet();
    for (const b of blocks) if (!reach.has(b)) issues.push({ msg: `线路「${b}」不可达: 没有任何选项/跳转/帮助点指向它`, block: b });
  }
  return issues;
}

let _issues = [];
function _renderIssues() {
  const btn = $("te-issues"); if (!btn) return;
  _issues = _cur ? _validateTut() : [];
  btn.textContent = _issues.length ? `⚠${_issues.length}` : "✓链路";
  btn.classList.toggle("text-error", _issues.length > 0);
  btn.title = _issues.length ? "链路有问题, 点击查看并跳转" : "链路完整: 无断链、无不可达线路";
}

function _openIssuesMenu() {
  if (!_cur) return;
  _renderIssues();
  const items = _issues.length
    ? _issues.map((iss, i) => [String(i), `⚠ ${_e(iss.msg)}`, true])
    : [["ok", "✓ 链路完整: 无断链、无不可达线路"]];
  const m = _openCtxMenu($("te-issues"), items);
  m.style.maxWidth = "420px";
  m.querySelector('[data-k="ok"]')?.addEventListener("click", _closeCtxMenu);
  _issues.forEach((iss, i) => {
    m.querySelector(`[data-k="${i}"]`)?.addEventListener("click", () => {
      _closeCtxMenu();
      if (iss.block && _cur[iss.block]) {
        _selBlock = iss.block; _selScene = iss.si ?? 0; _selDialog = iss.di ?? 0;
        if (_flowOn) _toggleFlow();
        _renderAll();
      }
    });
  });
}

function _enableBtns(on) {
  for (const id of ["te-save", "te-play", "te-del", "te-export", "te-issues", "te-flow", "te-record"]) { const el = $(id); if (el) el.disabled = !on; }
}

// ── 辅助 ──

function _getBlocks() {
  if (!_cur) return [];
  return Object.keys(_cur).filter(k => !RESERVED_KEYS.includes(k) && Array.isArray(_cur[k]));
}
function _getScene() { return _cur?.[_selBlock]?.[_selScene] || null; }
function _getDialog() { return _getScene()?.dialogs?.[_selDialog] || null; }

// ── 渲染总调度 ──

function _renderAll() {
  _syncPreviewVars();
  _renderBlocks();
  _renderDialogList();
  _renderCanvas();
  _renderProps();
  _renderIssues();
  const s = _getScene();
  if ($("te-bg-img")) $("te-bg-img").value = s?.background_image || "";
  // 音乐库下拉: 重填选项(库可能刷新)+按当前场景URL反选
  const lib = $("te-bg-music-lib");
  if (lib) {
    const curFile = decodeURIComponent((s?.background_music || "").split("/").pop() || "");
    lib.innerHTML = '<option value="">无</option>' + _sounds.map(f =>
      `<option value="${_e(f)}" ${f === curFile ? "selected" : ""}>${_e(f)}</option>`).join("");
  }
  const scenes = _cur?.[_selBlock] || [];
  if ($("te-scene-label")) $("te-scene-label").textContent = scenes.length ? `${_selScene + 1}/${scenes.length}` : "";
}

// ── 顶部: Block导航 ──

function _renderBlocks() {
  const el = $("te-blocks"); if (!el) return;
  const blocks = _getBlocks();
  const launch = _cur?.parameters?.launch_story;
  el.innerHTML = blocks.map(b =>
    `<button class="te-block-btn ${b === _selBlock ? 'active' : ''}" data-bk="${_e(b)}" title="${b === _selBlock ? '再点一次: 重命名/删除/设起点' : '切换到此线路 · 右键: 重命名/删除/设起点'}">${b === launch ? "▶" : ""}${_e(b)}</button>`).join("");
  el.querySelectorAll("[data-bk]").forEach(btn => {
    // 点未选中=切换; 点已选中=线路菜单(操作闭环: 同一入口能进就能管理); 右键任意=菜单
    btn.addEventListener("click", (e) => {
      if (btn.dataset.bk === _selBlock) { e.stopPropagation(); _blockMenu(btn.dataset.bk, btn); return; }
      _selBlock = btn.dataset.bk; _selScene = 0; _selDialog = 0; _renderAll();
    });
    btn.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); _blockMenu(btn.dataset.bk, btn); });
  });
}

// ── 左栏: 对话列表 ──

function _renderDialogList() {
  _touch(); // 编辑必经渲染点=自动保存触发点(幂等)
  const el = $("te-dialog-list"); if (!el) return;
  const scene = _getScene();
  const dialogs = scene?.dialogs || [];
  el.innerHTML = dialogs.map((d, i) => {
    const name = typeof d.name === "string" ? d.name : "";
    const text = (d.text || "").slice(0, 40);
    const hasChoice = d.choice?.length > 0;
    const hasArt = d.art?.length > 0;
    const hasGoto = !!d.go_to;
    return `
    <div class="te-dlg-item ${i === _selDialog ? 'active' : ''}" data-di="${i}">
      <div class="te-dlg-num">${i}</div>
      <div class="te-dlg-preview">
        ${name ? `<div class="te-dlg-name">${_e(name)}</div>` : ''}
        <div class="te-dlg-text">${_e(text) || '<空>'}</div>
        <div class="te-dlg-badges">
          ${hasChoice ? '<span>⑂选项</span>' : ''}
          ${hasArt ? '<span>🖼立绘</span>' : ''}
          ${hasGoto ? '<span>→跳转</span>' : ''}
          ${d.await_click ? '<span>◎引导</span>' : ''}
        </div>
      </div>
    </div>`;
  }).join("") || '<div class="opacity-30 text-xs py-4 text-center">无对话</div>';
  el.querySelectorAll("[data-di]").forEach(item => item.addEventListener("click", () => {
    _selDialog = +item.dataset.di; _renderAll();
  }));
}

// ── 舞台渲染: engine 在真实界面上渲染当前对话(凛倾MSG#15"中间是界面和拖动"), 编辑交互挂其元素 ──

let _stageSeq = 0;       // 渲染序列: 快速切换时丢弃过期渲染(异步竞态守卫)
let _stageBound = false; // 持久节点(#tut-name/#tut-text/grip)只绑一次

async function _renderCanvas() {
  _touch(); // 编辑必经渲染点=自动保存触发点(幂等)
  if (!_cur || !_selBlock) { stopEditRender(); return; }
  const seq = ++_stageSeq;
  await renderDialogForEdit(_cur, _selBlock, _selScene, _selDialog).catch(e => console.warn("[tut-editor] render:", e?.message));
  if (seq !== _stageSeq) return; // 已有更新的渲染
  _bindStage();
}

/** 每次舞台渲染后: 给engine元素贴编辑控件(立绘拖/缩放/工具条, 选项菜单, ＋选项) */
function _bindStage() {
  const ov = document.getElementById("tut-overlay");
  if (!ov) return;
  _bindStageOnce(ov);
  const dlg = _getDialog();

  // 立绘: 选中/拖动/缩放/工具条(art元素data-art-id=索引, engine同源)
  ov.querySelectorAll("#tut-art-layer .tut-art").forEach(el => {
    const i = Number(el.dataset.artId);
    const a = dlg?.art?.[i];
    if (!a) return;
    if (!el.querySelector(".te-art-resize")) {
      el.insertAdjacentHTML("beforeend",
        `<div class="te-art-resize" title="拖动缩放"></div>
         <div class="te-art-tools"><button data-at="img">换图</button><button data-at="del">删除</button></div>`);
      el.addEventListener("click", () => {
        ov.querySelectorAll(".tut-art").forEach(x => x.classList.remove("te-selected"));
        el.classList.add("te-selected");
      });
      el.querySelector('[data-at="img"]').addEventListener("click", (e) => { e.stopPropagation(); _artImagePicker(a); });
      el.querySelector('[data-at="del"]').addEventListener("click", (e) => {
        e.stopPropagation();
        dlg.art.splice(i, 1); if (!dlg.art.length) delete dlg.art;
        _renderCanvas(); _renderProps(); _renderDialogList();
      });
      _bindArtDrag(el, a, i);
      _bindArtResize(el, a);
    }
  });

  // 选项: 点击=编辑菜单(凛倾"点击选项做点击选项之后的对话"); 尾部＋选项
  const choicesEl = ov.querySelector("#tut-choices");
  if (choicesEl && dlg) {
    choicesEl.querySelectorAll("[data-edit-choice]").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        _renderChoiceProps(+btn.dataset.editChoice);
        _choiceCtxMenu(dlg, +btn.dataset.editChoice, btn);
      });
    });
    if (!choicesEl.querySelector(".te-choice-add")) {
      const add = document.createElement("button");
      add.className = "te-choice-add";
      add.textContent = "＋选项";
      add.addEventListener("click", () => _addChoice(dlg));
      choicesEl.appendChild(add);
    }
  }
}

/** 持久节点一次性绑定: 文字/名字直编 + 对话框grip拖动(engine的panel节点跨渲染保留) */
function _bindStageOnce(ov) {
  if (_stageBound) return;
  _stageBound = true;
  const nameEl = ov.querySelector("#tut-name");
  const textEl = ov.querySelector("#tut-text");
  const panel = ov.querySelector("#tut-text-panel");
  nameEl.setAttribute("contenteditable", "plaintext-only");
  nameEl.dataset.ph = "角色名";
  textEl.setAttribute("contenteditable", "plaintext-only");
  textEl.dataset.ph = "点击输入对话文字…";
  textEl.addEventListener("input", () => { const d = _getDialog(); if (d && isEditRender()) d.text = textEl.textContent; });
  textEl.addEventListener("blur", () => { if (isEditRender()) { _renderDialogList(); _renderProps(); } });
  nameEl.addEventListener("input", () => { const d = _getDialog(); if (d && isEditRender()) d.name = nameEl.textContent.trim(); });
  nameEl.addEventListener("blur", () => { if (isEditRender()) { _renderDialogList(); _renderProps(); } });

  // 对话框拖角手柄→text_panel.width(vw相对单位, 凛倾: 不要硬编码要能直接调)
  const dResize = document.createElement("div");
  dResize.className = "te-art-resize";
  dResize.title = "拖动调整对话框宽度";
  panel.appendChild(dResize);
  dResize.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || !_cur || !isEditRender()) return;
    e.preventDefault(); e.stopPropagation();
    const pr = panel.getBoundingClientRect();
    const move = (ev) => {
      const wVw = Math.max(20, ((ev.clientX - pr.left) / innerWidth) * 100 * 2); // ×2: 面板居中锚, 拖右缘=半宽
      _setTp("width", Math.min(96, wVw).toFixed(1) + "vw");
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      _renderProps();
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });

  // grip拖动→text_panel.left/bottom(viewport坐标=运行时同系)
  const grip = document.createElement("div");
  grip.className = "te-dlg-grip";
  grip.title = "拖动调整对话框位置";
  panel.prepend(grip);
  grip.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || !_cur || !isEditRender()) return;
    e.preventDefault();
    const move = (ev) => {
      const leftPct = Math.min(100, Math.max(0, (ev.clientX / innerWidth) * 100));
      const bottomPx = Math.max(0, Math.round(innerHeight - ev.clientY - panel.offsetHeight / 2));
      _setTp("left", leftPct.toFixed(1) + "%");
      _setTp("bottom", bottomPx + "px");
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      _renderProps();
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
}

/** 退出编辑态: 移除contenteditable(预览/真播时不可编辑), grip藏由stopEditRender隐藏panel带走 */
function _unbindStageEditing() {
  const ov = document.getElementById("tut-overlay");
  ov?.querySelector("#tut-name")?.removeAttribute("contenteditable");
  ov?.querySelector("#tut-text")?.removeAttribute("contenteditable");
  ov?.querySelector(".te-dlg-grip")?.remove();
  ov?.querySelectorAll(".te-art-resize, .te-art-tools").forEach(x => x.remove());
  _stageBound = false;
}

// ── 画布上下文菜单(单例) ──

let _ctxMenu = null;
function _closeCtxMenu() { _ctxMenu?.remove(); _ctxMenu = null; }
function _openCtxMenu(anchorEl, items) {
  _closeCtxMenu();
  const m = document.createElement("div");
  m.className = "te-ctx-menu";
  m.innerHTML = items.map(([key, label, danger]) => `<button data-k="${key}" class="${danger ? "danger" : ""}">${label}</button>`).join("");
  document.body.appendChild(m);
  const r = anchorEl.getBoundingClientRect();
  m.style.left = Math.min(r.left, innerWidth - m.offsetWidth - 8) + "px";
  m.style.top = (r.bottom + 4 + m.offsetHeight > innerHeight ? r.top - m.offsetHeight - 4 : r.bottom + 4) + "px";
  const onDoc = (e) => { if (!m.contains(e.target)) { _closeCtxMenu(); document.removeEventListener("click", onDoc, true); } };
  setTimeout(() => document.addEventListener("click", onDoc, true), 0);
  _ctxMenu = m;
  return m;
}

function _addChoice(dlg) {
  if (!dlg.choice) dlg.choice = [];
  dlg.choice.push({ text: "新选项" });
  _renderCanvas(); _renderProps(); _renderDialogList();
}

/** 选项菜单: 改文字(inline) / 点击后的对话(进分支,无则建) / 删除 */
function _choiceCtxMenu(dlg, ci, chEl) {
  const c = dlg.choice[ci];
  const m = _openCtxMenu(chEl, [
    ["edit", "✎ 改选项文字"],
    ["branch", c.go_to && c.go_to !== "tue_go" ? "→ 编辑点击后的对话" : "＋ 创建点击后的对话"],
    ["next", c.go_to === "tue_go" ? "✓ 点击后=下一场景" : "点击后=下一场景"],
    ["del", "× 删除选项", true],
  ]);
  m.querySelector('[data-k="edit"]').addEventListener("click", () => {
    _closeCtxMenu();
    chEl.contentEditable = "plaintext-only";
    chEl.focus();
    document.getSelection()?.selectAllChildren(chEl);
    const done = () => {
      chEl.removeAttribute("contenteditable");
      c.text = chEl.textContent.trim() || c.text;
      _renderCanvas(); _renderProps();
    };
    chEl.addEventListener("blur", done, { once: true });
    chEl.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); chEl.blur(); } });
  });
  m.querySelector('[data-k="branch"]').addEventListener("click", () => {
    _closeCtxMenu();
    _gotoChoiceBranch(c);
  });
  m.querySelector('[data-k="next"]').addEventListener("click", () => {
    _closeCtxMenu();
    c.go_to = "tue_go";
    _renderProps();
  });
  m.querySelector('[data-k="del"]').addEventListener("click", () => {
    _closeCtxMenu();
    dlg.choice.splice(ci, 1); if (!dlg.choice.length) delete dlg.choice;
    _renderCanvas(); _renderProps(); _renderDialogList();
  });
}

/** 进入"选项点击后"的分支block: 已指向block=跳过去; 未指向=用选项文字建新block并跳入 */
function _gotoChoiceBranch(c) {
  let target = c.go_to;
  if (!target || target === "tue_go" || !Array.isArray(_cur?.[target])) {
    // 新block名=选项文字(去空格截12字), 冲突加序号 — 中文键合法(引擎按对象键取block)
    let base = String(c.text || "分支").replace(/\s+/g, "").slice(0, 12) || "分支";
    let name = base, n = 2;
    while (_cur[name] !== undefined) name = base + n++;
    _cur[name] = [{ dialogs: [{ text: "" }] }];
    c.go_to = name;
    target = name;
  }
  _selBlock = target; _selScene = 0; _selDialog = 0;
  _renderAll();
  setTimeout(() => document.getElementById("tut-text")?.focus(), 150);
}

// ── 舞台立绘拖拽: viewport百分比(=运行时#tut-art-layer坐标系)写回 art.position ──

function _bindArtDrag(el, art, idx) {
  el.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || !isEditRender()) return;
    e.preventDefault(); e.stopPropagation(); // 不触发engine的运行时拖(会话级不写回)
    const eRect = el.getBoundingClientRect();
    const offX = e.clientX - eRect.left, offY = e.clientY - eRect.top;
    el.style.transition = "none";
    const move = (ev) => {
      const left = ((ev.clientX - offX) / innerWidth) * 100;
      const top = ((ev.clientY - offY) / innerHeight) * 100;
      art.position = [left.toFixed(1) + "%", "0", top.toFixed(1) + "%", "0"];
      applyArtLayout(el, art);
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      el.style.transition = "";
      _renderProps(); // 右栏同步新坐标
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
}

// ── 流程图视图: Block节点 + go_to连线(SVG贝塞尔, 参照tuesday-js world canvas) ──
// 节点坐标存教程JSON parameters.editor_pos = { blockName:[x,y] }(编辑器元数据, 运行时忽略)

let _flowOn = false;

function _toggleFlow() {
  _flowOn = !_flowOn;
  $("te-flow-wrap")?.classList.toggle("active", _flowOn);
  $("te-flow")?.classList.toggle("btn-warning", _flowOn);
  if (_flowOn) _renderFlow(); // 关闭按钮/自动排列在_bindAll一次性绑定
}

/** 跨线路跳转边(带来源标签, _forEachRef单源): 选项边=⑂选项文字, 其余=类型; tue_go(场景内推进)不算边 */
function _blockEdges() {
  const blockSet = new Set(_getBlocks());
  const seen = new Set(); const edges = [];
  _forEachRef(r => {
    if (!r.block) return; // 帮助点/自动触发=入口非节点间边
    const to = _refBlockOf(r.get());
    if (!to || !blockSet.has(to) || to === r.block) return;
    const label = r.kind === "choice" ? "⑂" + (String(r.text || "").slice(0, 10) || "选项")
      : r.kind === "timer" ? "⏱定时" : r.kind === "await" ? "◎引导" : "→跳转";
    const key = `${r.block}|${to}|${label}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ from: r.block, to, label });
  });
  return edges;
}

/** BFS分层自动布局: 起点顶层, 每跳一层向下(分支自然展开, 合并线沉底); 不可达排最底层。
 *  手动拖过的节点(editor_pos)优先用手动坐标, "自动排列"按钮清掉手动坐标回到此布局 */
function _flowLayout(blocks, edges) {
  const launch = _cur?.parameters?.launch_story;
  const adj = {};
  edges.forEach(e => (adj[e.from] ??= new Set()).add(e.to));
  const depth = {};
  if (launch && blocks.includes(launch)) {
    depth[launch] = 0;
    const q = [launch];
    while (q.length) { const b = q.shift(); for (const t of adj[b] || []) if (depth[t] === undefined) { depth[t] = depth[b] + 1; q.push(t); } }
  }
  let maxD = 0; for (const d of Object.values(depth)) maxD = Math.max(maxD, d);
  const rows = [];
  for (const b of blocks) { const d = depth[b] ?? maxD + 1; (rows[d] ??= []).push(b); }
  const pos = {};
  rows.forEach((row, d) => (row || []).forEach((b, i) => { pos[b] = [40 + i * 190, 48 + d * 130]; }));
  return pos;
}

function _renderFlow() {
  const nodesEl = $("te-flow-nodes"), svg = $("te-flow-svg");
  if (!nodesEl || !svg || !_cur) return;
  const blocks = _getBlocks();
  const blockSet = new Set(blocks);
  const launch = _cur.parameters?.launch_story;
  const edges = _blockEdges();
  const auto = _flowLayout(blocks, edges);
  const reach = _reachableSet();
  const dangling = new Set(); // 有断链跳转的来源节点
  _forEachRef(r => { const t = _refBlockOf(r.get()); if (r.block && t && !blockSet.has(t)) dangling.add(r.block); });
  nodesEl.innerHTML = "";
  const posMap = {};
  blocks.forEach((b) => {
    const saved = _cur?.parameters?.editor_pos?.[b];
    const [x, y] = Array.isArray(saved) ? saved : auto[b];
    posMap[b] = [x, y];
    const scenes = _cur[b] || [];
    const dlgCount = scenes.reduce((n, s) => n + (s?.dialogs?.length || 0), 0);
    const unreach = launch && blockSet.has(launch) && !reach.has(b);
    const node = document.createElement("div");
    node.className = `te-flow-node ${b === launch ? "launch" : ""} ${b === _selBlock ? "active" : ""} ${unreach ? "unreach" : ""}`;
    node.style.left = x + "px"; node.style.top = y + "px";
    node.dataset.block = b;
    node.title = "单击=进入编辑 · 拖动=摆放 · 右键=重命名/删除/设起点";
    node.innerHTML = `<div class="fn-title">${_e(b)}</div>
      <div class="fn-meta">${scenes.length}场景 · ${dlgCount}对话${b === launch ? " · ▶起点" : ""}</div>
      ${unreach ? '<div class="fn-warn">⚠ 不可达: 无选项/跳转/入口指向</div>' : ""}
      ${dangling.has(b) ? '<div class="fn-warn">⚠ 含断链跳转(见链路检查)</div>' : ""}`;
    node.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); _blockMenu(b, node); });
    // 拖拽摆放(坐标写回 parameters.editor_pos) / 单击(未拖)=进入该线路编辑
    node.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const sx = e.clientX - node.offsetLeft, sy = e.clientY - node.offsetTop;
      let moved = false;
      const mv = (ev) => {
        moved = true;
        const nx = Math.max(0, ev.clientX - sx), ny = Math.max(0, ev.clientY - sy);
        node.style.left = nx + "px"; node.style.top = ny + "px";
        posMap[b] = [nx, ny];
        _drawFlowEdges(svg, posMap);
      };
      const up = () => {
        document.removeEventListener("mousemove", mv);
        document.removeEventListener("mouseup", up);
        if (moved) {
          if (!_cur.parameters) _cur.parameters = {};
          if (!_cur.parameters.editor_pos) _cur.parameters.editor_pos = {};
          _cur.parameters.editor_pos[b] = posMap[b];
          _touch(); // 摆放也是编辑, 落盘
        } else {
          _selBlock = b; _selScene = 0; _selDialog = 0;
          _toggleFlow(); _renderAll();
        }
      };
      document.addEventListener("mousemove", mv);
      document.addEventListener("mouseup", up);
    });
    nodesEl.appendChild(node);
  });
  _drawFlowEdges(svg, posMap);
}

function _drawFlowEdges(svg, posMap) {
  const edges = _blockEdges();
  const nodesEl = $("te-flow-nodes");
  const nodeEls = {};
  if (nodesEl) nodesEl.querySelectorAll(".te-flow-node").forEach(n => { if (n.dataset.block) nodeEls[n.dataset.block] = n; });
  const pairN = {}; // 同一对节点多条边(多个选项)时错开, 标签不叠
  svg.innerHTML = `<defs><marker id="te-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0L10,5L0,10z" fill="var(--color-warning)"/></marker></defs>` +
    edges.map(({ from: f, to: t, label }) => {
      const a = posMap[f], b = posMap[t];
      if (!a || !b) return "";
      const fEl = nodeEls[f], tEl = nodeEls[t];
      const fw = fEl?.offsetWidth || 120, fh = fEl?.offsetHeight || 50;
      const tw = tEl?.offsetWidth || 120;
      const nth = pairN[f + "|" + t] = (pairN[f + "|" + t] || 0) + 1;
      const off = (nth - 1) * 16;
      const x1 = a[0] + fw / 2 + off, y1 = a[1] + fh, x2 = b[0] + tw / 2 + off, y2 = b[1] - 4;
      const my = (y1 + y2) / 2;
      return `<path class="te-flow-edge" marker-end="url(#te-arrow)" d="M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}" />`
        + `<text class="te-flow-elabel" x="${(x1 + x2) / 2}" y="${my - 4 + (nth - 1) * 12}" text-anchor="middle">${_e(label)}</text>`;
    }).join("");
}

// ── 搜索: 台词/角色/选项/选择器全文匹配, 点结果跳到该对话(Ctrl+F 聚焦) ──

function _doSearch(q) {
  const box = $("te-search-results");
  if (!box) return;
  q = (q || "").trim().toLowerCase();
  if (!q || !_cur) { box.classList.add("hidden"); box.innerHTML = ""; return; }
  const hits = [];
  for (const b of _getBlocks()) {
    (_cur[b] || []).forEach((scene, si) => {
      (scene?.dialogs || []).forEach((d, di) => {
        const hay = [d.text, d.name, typeof d.await_click === "string" ? d.await_click : d.await_click?.selector,
          ...(d.choice || []).map(c => c.text)].filter(Boolean).join(" ").toLowerCase();
        if (hay.includes(q)) hits.push({ b, si, di, text: (d.text || d.name || "").slice(0, 46) });
      });
    });
  }
  box.innerHTML = hits.slice(0, 50).map((h, i) =>
    `<div class="te-sr-item" data-sr="${i}"><div>${_e(h.text) || "<空>"}</div><div class="te-sr-loc">${_e(h.b)} · 场景${h.si + 1} · 对话${h.di}</div></div>`
  ).join("") || '<div class="opacity-40 text-xs p-2">无结果</div>';
  box.classList.remove("hidden");
  box.querySelectorAll("[data-sr]").forEach(el => el.addEventListener("click", () => {
    const h = hits[+el.dataset.sr];
    _selBlock = h.b; _selScene = h.si; _selDialog = h.di;
    if (_flowOn) _toggleFlow();
    box.classList.add("hidden");
    _renderAll();
  }));
}

// ── 立绘拖角缩放: 右下手柄拖动=按画布宽百分比写 art.size[0](高auto等比), 与拖拽同一写点 ──

function _bindArtResize(el, art) {
  const handle = el.querySelector(".te-art-resize");
  if (!handle) return;
  handle.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || !isEditRender()) return;
    e.preventDefault(); e.stopPropagation(); // 不触发移动拖拽
    const eRect = el.getBoundingClientRect();
    el.style.transition = "none";
    const move = (ev) => {
      const wPct = Math.max(4, ((ev.clientX - eRect.left) / innerWidth) * 100);
      art.size = [wPct.toFixed(1) + "%", "auto"];
      applyArtLayout(el, art);
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      el.style.transition = "";
      _renderProps();
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
}

// ── 声音库浏览器: 列全部文件+逐个试听▶+一键选用(打字音效/本场景音乐) ──

let _sndAudio = null; // 试听单例: 换曲即停旧的

function _openSoundBrowser() {
  _closeCtxMenu();
  const m = document.createElement("div");
  m.className = "te-ctx-menu";
  m.style.cssText = "max-height:64vh;overflow-y:auto;min-width:300px;";
  const stopPlay = () => { try { _sndAudio?.pause(); } catch { /* 已停 */ } _sndAudio = null; m.querySelectorAll("[data-play]").forEach(b => b.textContent = "▶"); };
  m.innerHTML = `<div class="text-[10px] opacity-50 px-2 py-1">系统声音库 data/tutorials/sounds/(${_sounds.length}) · 女声=female_light系列</div>` +
    (_sounds.length ? _sounds.map(f => `
      <div style="display:flex;align-items:center;gap:4px;padding:2px 4px;">
        <button data-play="${_e(f)}" style="width:26px;">▶</button>
        <span style="flex:1;font-size:11px;overflow:hidden;text-overflow:ellipsis;">${_e(f)}</span>
        <button data-usetype="${_e(f)}" title="设为打字音效(全教程)" style="font-size:10px;">打字音</button>
        <button data-usebgm="${_e(f)}" title="设为当前场景音乐" style="font-size:10px;">音乐</button>
      </div>`).join("") : '<div class="text-xs opacity-40 px-2 py-2">空 — 往目录放音频文件即入库</div>');
  document.body.appendChild(m);
  const anchor = $("te-sounds").getBoundingClientRect();
  m.style.left = Math.min(anchor.left, innerWidth - m.offsetWidth - 8) + "px";
  m.style.top = (anchor.bottom + 4) + "px";
  m.querySelectorAll("[data-play]").forEach(b => b.addEventListener("click", (e) => {
    e.stopPropagation();
    const f = b.dataset.play;
    if (_sndAudio && !_sndAudio.paused && _sndAudio._f === f) { stopPlay(); return; }
    stopPlay();
    _sndAudio = new Audio(soundUrl(f));
    _sndAudio._f = f;
    _sndAudio.play().catch(e => { if (e?.name !== "NotAllowedError") console.debug("[tut-editor] audio:", e?.message); });
    b.textContent = "⏸";
    _sndAudio.addEventListener("ended", stopPlay, { once: true });
  }));
  m.querySelectorAll("[data-usetype]").forEach(b => b.addEventListener("click", () => {
    if (!_cur) return window._beiluToast?.("先新建或选择教程", "info");
    _setTp("type_sound", "snd:" + b.dataset.usetype);
    _renderProps();
    window._beiluToast?.("已设为打字音效", "success");
  }));
  m.querySelectorAll("[data-usebgm]").forEach(b => b.addEventListener("click", () => {
    const s = _getScene();
    if (!s) return window._beiluToast?.("先新建或选择教程", "info");
    s.background_music = soundUrl(b.dataset.usebgm);
    _renderAll();
    window._beiluToast?.("已设为本场景音乐", "success");
  }));
  const onDoc = (e) => { if (!m.contains(e.target)) { stopPlay(); m.remove(); document.removeEventListener("click", onDoc, true); } };
  setTimeout(() => document.addEventListener("click", onDoc, true), 0);
}

// ── 图包选图浮窗: 包→表情两级点选, 点表情即写url落画布(换图/新加角色共用) ──

function _artImagePicker(art) {
  _closeCtxMenu();
  const m = document.createElement("div");
  m.className = "te-ctx-menu";
  m.style.cssText = "max-height:60vh;overflow-y:auto;min-width:180px;";
  const render = (pack) => {
    if (!pack) {
      m.innerHTML = `<div class="text-[10px] opacity-50 px-2 py-1">选图包</div>` +
        (_packs.length ? _packs.map(p => `<button data-pk="${_e(p.name)}">📦 ${_e(p.name)}</button>`).join("")
          : '<div class="text-xs opacity-40 px-2 py-2">无图包(在游戏陪伴里添加)</div>');
      m.querySelectorAll("[data-pk]").forEach(b => b.addEventListener("click", (e) => {
        e.stopPropagation();
        render(_packs.find(p => p.name === b.dataset.pk));
      }));
    } else {
      const exprs = Object.entries(pack.expressions || {});
      m.innerHTML = `<button data-back="1">← ${_e(pack.name)}</button>` +
        exprs.map(([expr, files]) => Array.isArray(files) && files.length
          ? `<button data-ex="${_e(expr)}" data-f="${_e(files[0])}">${_e(expr)}</button>` : "").join("");
      m.querySelector("[data-back]").addEventListener("click", (e) => { e.stopPropagation(); render(null); });
      m.querySelectorAll("[data-ex]").forEach(b => b.addEventListener("click", () => {
        // 写pack+expr语义引用(非裸url): 图包更新教程自动跟随, 同表情多张运行时随机(小圆机制)
        delete art.url;
        art.pack = pack.name;
        art.expr = b.dataset.ex;
        m.remove();
        _renderCanvas(); _renderProps(); _renderDialogList();
      }));
    }
  };
  render(null);
  document.body.appendChild(m);
  // 屏幕中上弹出(舞台=真实界面全屏)
  m.style.left = "50%"; m.style.top = "50%";
  m.style.transform = "translate(-50%, -50%)";
  const onDoc = (e) => {
    if (!m.contains(e.target)) {
      m.remove(); document.removeEventListener("click", onDoc, true);
      // 新加的空立绘(无url也无pack引用)取消选择=撤销添加(不留死条目)
      const d = _getDialog();
      const last = d?.art?.[d.art.length - 1];
      if (last && !last.url && !last.pack) { d.art.pop(); if (!d.art.length) delete d.art; _renderCanvas(); _renderProps(); }
    }
  };
  setTimeout(() => document.addEventListener("click", onDoc, true), 0);
}

// ── 元素拾取器: 页面上点一下=选定引导目标(直接操作, 不手填selector) ──

let _pickCleanup = null;

/** 为元素生成稳定selector: id > data-aux/data-tab等data-*属性 > 唯一class组合 > 短nth路径 */
function _selectorFor(el) {
  if (el.id) return `#${CSS.escape(el.id)}`;
  // data-*属性(beilu按键绑定惯例: data-aux/data-tab/data-act/data-ic 等)
  for (const a of el.attributes) {
    if (a.name.startsWith("data-") && a.value) {
      const sel = `[${a.name}="${CSS.escape(a.value)}"]`;
      try { if (document.querySelectorAll(sel).length === 1) return sel; } catch { /* 非法值跳过 */ }
    }
  }
  // 类名组合唯一即用
  if (el.classList.length) {
    const sel = el.tagName.toLowerCase() + [...el.classList].map(c => "." + CSS.escape(c)).join("");
    try { if (document.querySelectorAll(sel).length === 1) return sel; } catch { /* 跳过 */ }
  }
  // 兜底: 最近有id/data-*祖先 + nth-child 短路径
  const parts = [];
  let cur = el;
  while (cur && cur !== document.body && parts.length < 4) {
    const p = cur.parentElement;
    if (cur.id) { parts.unshift(`#${CSS.escape(cur.id)}`); break; }
    const idx = p ? [...p.children].indexOf(cur) + 1 : 1;
    parts.unshift(`${cur.tagName.toLowerCase()}:nth-child(${idx})`);
    cur = p;
  }
  return parts.join(" > ");
}

function _startElementPick(onPicked) {
  _stopElementPick();
  const ov = $("tut-editor-overlay");
  ov?.classList.add("hidden"); // 浮条让位
  stopEditRender();            // 教程层让位(立绘/对话框不挡拾取目标)
  const hl = document.createElement("div");
  hl.id = "te-pick-hl";
  hl.style.cssText = "position:fixed;pointer-events:none;z-index:100003;border:2px solid var(--color-warning);border-radius:4px;background:color-mix(in oklch, var(--color-warning) 12%, transparent);transition:all .06s;";
  const tip = document.createElement("div");
  tip.style.cssText = "position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:100004;padding:6px 14px;border-radius:8px;background:var(--color-neutral);color:var(--color-neutral-content);font-size:12px;box-shadow:0 4px 16px rgba(0,0,0,.3);pointer-events:none;";
  tip.textContent = "点击要引导用户点的按钮/元素 · ESC取消";
  document.body.append(hl, tip);
  const TIP_DEFAULT = "点击要引导用户点的按钮/元素 · ESC取消";
  let target = null;
  const mm = (e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === hl || el === tip || el.closest("#tut-editor-overlay, #tut-overlay")) { target = null; hl.style.width = "0"; return; }
    // IFRAME不可作目标: iframe内点击不冒泡到父文档, 运行时等待=教程卡死(消息区=iframe渲染)
    if (el.tagName === "IFRAME") {
      target = null; hl.style.width = "0";
      tip.textContent = "消息内容区(iframe)不能作为引导目标";
      return;
    }
    tip.textContent = TIP_DEFAULT;
    target = el;
    const r = el.getBoundingClientRect();
    Object.assign(hl.style, { left: r.left - 2 + "px", top: r.top - 2 + "px", width: r.width + "px", height: r.height + "px" });
  };
  const ck = (e) => {
    e.preventDefault(); e.stopPropagation();
    if (!target) return; // iframe/无效区: 不结束拾取, 让用户换个地方点
    onPicked(_selectorFor(target));
    _stopElementPick();
  };
  const esc = (e) => { if (e.key === "Escape") _stopElementPick(); };
  document.addEventListener("mousemove", mm, true);
  document.addEventListener("click", ck, true);
  document.addEventListener("keydown", esc, true);
  _pickCleanup = () => {
    document.removeEventListener("mousemove", mm, true);
    document.removeEventListener("click", ck, true);
    document.removeEventListener("keydown", esc, true);
    hl.remove(); tip.remove();
    ov?.classList.remove("hidden");
    _renderCanvas(); // 恢复编辑态舞台
    _pickCleanup = null;
  };
}

function _stopElementPick() { _pickCleanup?.(); }

// ── 录制模式: 在页面上真实点一遍操作, 每次点击自动生成一步引导(text空待补, await_click=所点元素) ──
// 点击不拦截(默认行为照常发生=边操作边录); ⏹/ESC结束回编辑器

let _recCleanup = null;

function _startRecord() {
  if (_recCleanup) return _recCleanup();
  const scene = _getScene(); if (!scene || !_cur) return;
  if (!scene.dialogs) scene.dialogs = [];
  $("tut-editor-overlay")?.classList.add("hidden");
  stopEditRender(); // 教程层让位: 录的是真实界面操作
  let count = 0;
  const bar = document.createElement("div");
  bar.style.cssText = "position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:100004;display:flex;gap:8px;align-items:center;padding:6px 14px;border-radius:8px;background:var(--color-error);color:var(--color-error-content);font-size:12px;box-shadow:0 4px 16px rgba(0,0,0,.35);";
  bar.innerHTML = `⏺ 录制中: 按顺序点击要引导的按钮 <b data-n>0</b> 步 <button data-stop style="padding:2px 10px;border-radius:5px;border:none;cursor:pointer;">⏹ 完成</button>`;
  document.body.appendChild(bar);
  const ck = (e) => {
    if (bar.contains(e.target) || e.target.closest("#tut-overlay")) return;
    // IFRAME内点击父文档收不到, IFRAME元素本身作目标=运行时死引导 → 跳过并提示
    if (e.target.tagName === "IFRAME") {
      const n = bar.querySelector("[data-n]");
      n.textContent = count + "(消息区不可录)";
      setTimeout(() => { n.textContent = count; }, 1500);
      return;
    }
    // 不 preventDefault: 真实交互照常发生, 边操作边录
    const sel = _selectorFor(e.target);
    scene.dialogs.push({ text: "", await_click: sel });
    bar.querySelector("[data-n]").textContent = ++count;
  };
  const esc = (e) => { if (e.key === "Escape") _stopRecord(); };
  const _stopRecord = () => {
    document.removeEventListener("click", ck, true);
    document.removeEventListener("keydown", esc, true);
    bar.remove();
    $("tut-editor-overlay")?.classList.remove("hidden");
    _recCleanup = null;
    _selDialog = Math.max(0, scene.dialogs.length - 1);
    _renderAll();
  };
  bar.querySelector("[data-stop]").addEventListener("click", _stopRecord);
  document.addEventListener("click", ck, true);
  document.addEventListener("keydown", esc, true);
  _recCleanup = _stopRecord;
}

// ── 右栏: 属性面板 ──

function _renderProps() {
  _touch(); // 编辑必经渲染点=自动保存触发点(拖拽up等只刷右栏的路径也要落盘)
  const el = $("te-props"); if (!el) return;
  const dlg = _getDialog();
  if (!dlg) {
    // 无选中对话时教程级样式仍可调节(text_panel不属于某条对话)
    el.innerHTML = _cur
      ? `<div class="opacity-30 text-xs py-4 text-center">选择一个对话</div>${_renderTextPanelSection()}`
      : '<div class="opacity-30 text-xs py-8 text-center">新建或选择教程</div>';
    if (_cur) _bindTextPanelInputs();
    return;
  }

  const blocks = _getBlocks();
  const vars = Object.keys(_cur?.parameters?.variables || {});
  const arts = dlg.art || [];
  const choices = dlg.choice || [];

  el.innerHTML = `
    <!-- 对话内容 -->
    <div class="te-prop-section">
      <div class="te-prop-title">对话内容</div>
      <div class="te-prop-row"><label>角色名</label><input id="tp-name" class="input input-xs input-bordered" value="${_e(typeof dlg.name === 'string' ? dlg.name : '')}" /></div>
      <div class="te-prop-row"><label>文字 <button id="tp-expand-text" class="btn btn-xs btn-ghost opacity-50">放大</button></label>
        <textarea id="tp-text" class="textarea textarea-xs textarea-bordered" rows="4">${_e(dlg.text || '')}</textarea></div>
      <div class="te-prop-row"><label>此对话后跳转(合并线路在这里选)</label>
        <select id="tp-goto" class="select select-xs select-bordered">
          <option value="">无(顺序下一对话)</option>
          <option value="tue_go" ${dlg.go_to === 'tue_go' ? 'selected' : ''}>下一场景</option>
          ${blocks.map(b => `<option value="${_e(b)}" ${dlg.go_to === b ? 'selected' : ''}>线路: ${_e(b)}</option>`).join("")}
          <option value="__new__">＋ 新建线路…</option>
        </select></div>
      <div class="te-prop-row"><label>定时(ms)</label><input id="tp-timer" type="number" class="input input-xs input-bordered" value="${dlg.timer?.[0] || ''}" placeholder="空=不自动" /></div>
      <div class="te-prop-row"><label>效果(进入此对话时)</label>
        <select id="tp-effect" class="select select-xs select-bordered">
          <option value="">无</option>
          <option value="screenShake" ${dlg.event === "screenShake" ? "selected" : ""}>💥 屏幕震动</option>
          <option value="screenFlash" ${dlg.event === "screenFlash" ? "selected" : ""}>⚡ 屏幕闪光</option>
          <option value="charShake" ${dlg.event === "charShake" ? "selected" : ""}>角色震动</option>
          <option value="charBounce" ${dlg.event === "charBounce" ? "selected" : ""}>角色弹跳</option>
        </select></div>
      <div class="te-prop-row"><label>引导点击(用户点了目标才继续)</label>
        <div class="flex gap-1 items-center">
          <button id="tp-pick" class="btn btn-xs btn-outline flex-1">🎯 在页面上拾取目标</button>
          ${dlg.await_click ? '<button id="tp-pick-clear" class="btn btn-xs btn-ghost text-error">清除</button>' : ''}
        </div>
        ${dlg.await_click ? `<div class="text-[10px] opacity-50 mt-0.5">已选: ${_e(typeof dlg.await_click === 'string' ? dlg.await_click : dlg.await_click?.selector || '')}</div>` : ''}
      </div>
      <div class="te-prop-row"><button id="tp-del-dlg" class="btn btn-xs btn-ghost text-error">删除此对话</button></div>
    </div>

    <!-- 立绘 -->
    <div class="te-prop-section">
      <div class="te-prop-title">立绘(${arts.length}) <button id="tp-add-art" class="btn btn-xs btn-ghost">+</button></div>
      <div id="tp-arts">${arts.map((a, i) => _renderArtCard(a, i)).join("") || '<span class="opacity-30 text-xs">无</span>'}</div>
    </div>

    <!-- 选项 -->
    <div class="te-prop-section">
      <div class="te-prop-title">选项(${choices.length}) <button id="tp-add-choice" class="btn btn-xs btn-ghost">+</button></div>
      <div id="tp-choices">${choices.map((c, i) => _renderChoiceCard(c, i, blocks, vars)).join("") || '<span class="opacity-30 text-xs">无选项</span>'}</div>
    </div>

    <!-- 角色控制(controll: 切角色/切表情/切tab, 复用beiluLive2d) -->
    <div class="te-prop-section">
      <div class="te-prop-title">角色控制(进入此对话时)</div>
      <div class="te-prop-row"><label>切换角色(图包/Live2D)</label>
        <input id="tp-ctrl-pack" class="input input-xs input-bordered" value="${_e(dlg.controll?.pack || '')}" placeholder="角色名(如 贝露)" /></div>
      <div class="te-prop-row"><label>切换表情</label>
        <input id="tp-ctrl-emotion" class="input input-xs input-bordered" value="${_e(dlg.controll?.emotion || '')}" placeholder="表情名(如 平静)" /></div>
      <div class="te-prop-row"><label>切换Tab</label>
        <input id="tp-ctrl-tab" class="input input-xs input-bordered" value="${_e(dlg.controll?.tab || '')}" placeholder="tab名(如 settings)" /></div>
    </div>

    ${_renderTextPanelSection()}

    <!-- 变量操作 -->
    <div class="te-prop-section">
      <div class="te-prop-title">变量操作 <button id="tp-add-vop" class="btn btn-xs btn-ghost">+</button></div>
      <div id="tp-vops">${(dlg.variables || []).map((op, i) => `
        <div class="flex gap-1 items-center mb-1">
          <select class="select select-xs select-bordered flex-1" data-vi="${i}" data-vf="name">
            <option value="">-</option>${vars.map(v => `<option value="${_e(v)}" ${op[0] === v ? 'selected' : ''}>${_e(v)}</option>`).join("")}
          </select>
          <select class="select select-xs select-bordered w-12" data-vi="${i}" data-vf="op">
            <option value="set" ${op[1] === 'set' ? 'selected' : ''}>set</option>
            <option value="add" ${op[1] === 'add' ? 'selected' : ''}>add</option>
          </select>
          <input class="input input-xs input-bordered w-14" value="${_e(op[2] ?? '')}" data-vi="${i}" data-vf="val" />
          <button class="btn btn-xs btn-ghost text-error" data-vi="${i}" data-vf="del">x</button>
        </div>
      `).join("") || '<span class="opacity-30 text-xs">无</span>'}</div>
    </div>
  `;

  _bindProps(dlg, blocks, vars);
}

// 对话框样式段(教程级 parameters.text_panel, 引擎applyTutCSSVars消费; 未动=默认/跟随桌宠气泡配置)
// 直接操作: 色=取色器, 数值=滑条(凛倾0715"不是写代码,是直接操作"); 滑条限值可被 _defaults.json editor_limits 覆盖
// 出厂限值单点(键: [min, max]); 存储形态: num=纯数字键(radius/dialog_speed), px/vw=带单位串
const _TP_LIMITS = { size_text: [10, 32], radius: [0, 28], width: [30, 100], bottom: [0, 300], dialog_speed: [5, 100], opacity: [10, 100] };
const _tpLimit = (k) => (Array.isArray(_defaults.editor_limits?.[k]) ? _defaults.editor_limits[k] : _TP_LIMITS[k]);

const _TP_COLORS = [["color", "底色"], ["color_text", "文字色"], ["border_color", "边框色"], ["name_color", "名字色"]];
const _TP_RANGES = [
  ["opacity", "透明度(%)", "pct"], // 桌宠"对话框&互动"面板同款(凛倾: 按游戏模式那样移植)
  ["size_text", "字号", "px"], ["radius", "圆角", "num"], ["width", "宽度", "vw"],
  ["bottom", "底部距离", "px"], ["dialog_speed", "打字速度(ms/字)", "num"],
  ["pause_full", "句号停顿(×字速)", "num"], ["pause_half", "逗号停顿(×字速)", "num"], // 字符节点演出节奏(Alice机制)
  ["choice_size", "选项字号", "px"], ["choice_dim", "选项遮罩深度(%)", "pct"], ["choice_blur", "选项背景模糊", "px"], // 小圆选择时刻层
];

/** 滑条当前值: 已设读JSON, 未设从TUT_DEFAULTS对应CSS变量解析数字, 解析不出取范围中值 */
const _TP_VAR_OF = { size_text: "--bubble-fs", radius: "--bubble-radius", bottom: "--tut-panel-bottom" };
function _tpRangeVal(k) {
  const v = _cur?.parameters?.text_panel?.[k];
  if (v != null && v !== "") return k === "opacity" ? Math.round(parseFloat(v) * 100) : parseFloat(v);
  const [min, max] = _tpLimit(k);
  const fromVar = _TP_VAR_OF[k] ? parseFloat($("tut-editor-win")?.style.getPropertyValue(_TP_VAR_OF[k])) : NaN;
  return Number.isFinite(fromVar) ? fromVar : Math.round((min + max) / 2);
}

function _renderTextPanelSection() {
  const tp = _cur?.parameters?.text_panel || {};
  const hp = _cur?.parameters?.help_points || [];
  const db = _cur?.parameters?.desk_button;
  const blocks = _getBlocks();
  return `
    <div class="te-prop-section">
      <div class="te-prop-title">对话框样式(全教程)</div>
      <div class="grid grid-cols-2 gap-1 mb-1">
      ${_TP_COLORS.map(([k, label]) => `
        <label class="flex items-center gap-1 text-[10px]"><span class="flex-1 opacity-60">${label}${tp[k] ? "" : " <i class='opacity-40'>(默认)</i>"}</span>
          <input type="color" class="w-6 h-5 rounded border border-base-300" data-tpc="${k}" value="${/^#[0-9a-fA-F]{6}$/.test(tp[k] || '') ? tp[k] : '#fffcf5'}" />
          <button class="btn btn-xs btn-ghost px-1" data-tpc-reset="${k}" title="恢复默认">↺</button>
        </label>`).join("")}
      </div>
      ${_TP_RANGES.map(([k, label, unit]) => {
        const [min, max] = _tpLimit(k);
        const val = _tpRangeVal(k);
        return `
      <div class="te-prop-row"><label>${label} <span class="opacity-60" data-tpr-val="${k}">${tp[k] != null && tp[k] !== "" ? _e(String(tp[k])) : "默认"}</span></label>
        <input type="range" min="${min}" max="${max}" value="${val}" class="range range-xs range-warning" data-tpr="${k}" data-unit="${unit}" /></div>`;
      }).join("")}
      <div class="te-prop-row"><label>打字音效(Undertale式每字一声) <button id="tp-snd-test" class="btn btn-xs btn-ghost opacity-60">▶ 试听</button></label>
        <select id="tp-type-sound" class="select select-xs select-bordered">
          <option value="">无</option>
          ${listBlipPresets().map(([k, label]) => `<option value="${k}" ${tp.type_sound === k ? "selected" : ""}>${_e(label)}</option>`).join("")}
          ${_sounds.map(f => `<option value="snd:${_e(f)}" ${tp.type_sound === "snd:" + f ? "selected" : ""}>📁 ${_e(f)}</option>`).join("")}
        </select>
        <div class="text-[10px] opacity-40">往 data/tutorials/sounds/ 放音频文件可扩充(系统级)</div></div>
      <button id="tp-style-reset" class="btn btn-xs btn-ghost w-full opacity-60">全部恢复默认</button>
    </div>
    <div class="te-prop-section">
      <div class="te-prop-title">帮助点(help_points) <button id="tp-add-hp" class="btn btn-xs btn-ghost">+</button></div>
      <div id="tp-help-points">${(hp || []).map((h, i) => `
        <div class="flex flex-col gap-1 mb-2 p-2 rounded" style="background:color-mix(in oklch, var(--color-base-200) 50%, transparent)">
          <div class="flex gap-1 items-center">
            <input class="input input-xs input-bordered flex-1" value="${_e(h.selector || '')}" placeholder="CSS选择器" data-hpi="${i}" data-hpf="selector" />
            <button class="btn btn-xs btn-ghost" data-hpi="${i}" data-hpf="pick" title="拾取">🎯</button>
            <button class="btn btn-xs btn-ghost text-error" data-hpi="${i}" data-hpf="del">x</button>
          </div>
          <input class="input input-xs input-bordered" value="${_e(h.label || '')}" placeholder="标签(如 安全中心)" data-hpi="${i}" data-hpf="label" />
          <select class="select select-xs select-bordered" data-hpi="${i}" data-hpf="story">
            <option value="">绑定block...</option>
            ${blocks.map(b => `<option value="${_e(b)}" ${h.story === b ? 'selected' : ''}>${_e(b)}</option>`).join("")}
          </select>
          <div class="flex gap-1">
            <select class="select select-xs select-bordered flex-1" data-hpi="${i}" data-hpf="trigger">
              <option value="overlay_icon" ${(h.trigger || 'overlay_icon') === 'overlay_icon' ? 'selected' : ''}>叠?图标</option>
              <option value="bind_click" ${h.trigger === 'bind_click' ? 'selected' : ''}>绑定click(点元素本身触发, 不叠?)</option>
              <option value="bind_hover" ${h.trigger === 'bind_hover' ? 'selected' : ''}>悬停触发</option>
              <option value="auto" ${h.trigger === 'auto' ? 'selected' : ''}>首次可见</option>
            </select>
            <select class="select select-xs select-bordered" data-hpi="${i}" data-hpf="position">
              <option value="top-right" ${(h.position || 'top-right') === 'top-right' ? 'selected' : ''}>右上</option>
              <option value="top-left" ${h.position === 'top-left' ? 'selected' : ''}>左上</option>
              <option value="bottom-right" ${h.position === 'bottom-right' ? 'selected' : ''}>右下</option>
              <option value="bottom-left" ${h.position === 'bottom-left' ? 'selected' : ''}>左下</option>
              <option value="center" ${h.position === 'center' ? 'selected' : ''}>居中</option>
            </select>
            <input class="input input-xs input-bordered w-14" value="${_e(String(h.style?.size || '').replace('px', ''))}"
              placeholder="大小px" title="?图标大小(想放明显就调大, 空=默认28)" data-hpi="${i}" data-hpf="size" />
          </div>
        </div>
      `).join("") || '<span class="opacity-30 text-xs">无帮助点</span>'}</div>
    </div>
    <!-- 桌宠式教程按钮(凛倾0715批注3: 点击一个按钮出现) -->
    <div class="te-prop-section">
      <div class="te-prop-title">桌宠教程按钮</div>
      <label class="flex items-center gap-2 text-[10px] mb-1"><input type="checkbox" id="tp-db-on" class="checkbox checkbox-xs" ${db ? 'checked' : ''} />
        启用: 界面常驻一个悬浮小按钮, 点击播放本教程</label>
      ${db ? `
      <div class="te-prop-row"><label>按钮文字</label><input id="tp-db-label" class="input input-xs input-bordered" value="${_e(db.label || '')}" placeholder="教程" /></div>
      <div class="te-prop-row"><label>点击播放线路</label>
        <select id="tp-db-story" class="select select-xs select-bordered">
          ${blocks.map(b => `<option value="${_e(b)}" ${db.story === b ? 'selected' : ''}>${_e(b)}</option>`).join("")}
        </select></div>
      <div class="te-prop-row"><label>位置</label>
        <select id="tp-db-pos" class="select select-xs select-bordered">
          ${[["bottom-right", "右下"], ["bottom-left", "左下"], ["top-right", "右上"], ["top-left", "左上"]].map(([v, l]) =>
            `<option value="${v}" ${(db.position || 'bottom-right') === v ? 'selected' : ''}>${l}</option>`).join("")}
        </select></div>` : ''}
    </div>
    <!-- 变量定义(教程级parameters.variables): 选项显示条件/点击改变/对话变量操作的单一变量池——
         没有这里, 那三处下拉全是空的(变量系统曾无定义入口=不可用) -->
    <div class="te-prop-section">
      <div class="te-prop-title">变量定义(教程级) <button id="tp-add-var" class="btn btn-xs btn-ghost">+</button></div>
      <div class="text-[10px] opacity-40 mb-1">定义后可在: 选项显示条件 / 选项点击改变 / 对话变量操作 里使用; 文本里&lt;变量名&gt;插值</div>
      ${Object.entries(_cur?.parameters?.variables || {}).map(([k, v], i) => `
        <div class="flex gap-1 mb-1 items-center">
          <span class="text-xs flex-1 font-mono">${_e(k)}</span>
          <input class="input input-xs input-bordered w-20" value="${_e(String(v))}" title="初始值" data-tvi="${i}" data-tvf="val" />
          <button class="btn btn-xs btn-ghost text-error" data-tvi="${i}" data-tvf="del">x</button>
        </div>`).join("") || '<span class="opacity-30 text-xs">无变量</span>'}
    </div>
    <!-- 高级视觉变量(凛倾"都是硬编码我怎么调整?"): 全部--tut-*/--bubble-*出厂键逐键覆盖,
         写parameters.css_vars(engine applyTutCSSVars第4步既有消费链), 键名datalist提示+默认值占位 -->
    <div class="te-prop-section">
      <div class="te-prop-title">高级视觉变量 <button id="tp-add-cv" class="btn btn-xs btn-ghost">+</button></div>
      <div class="text-[10px] opacity-40 mb-1">滑条没覆盖的全部视觉键在这逐个调(动画时长/发光/阴影/尺寸…), 输入框弹出全部键名提示</div>
      ${Object.entries(_cur?.parameters?.css_vars || {}).map(([k, v], i) => `
        <div class="flex gap-1 mb-1 items-center">
          <input list="tp-cv-keys" class="input input-xs input-bordered flex-1" value="${_e(k)}" data-cvi="${i}" data-cvf="k" />
          <input class="input input-xs input-bordered w-24" value="${_e(String(v))}" placeholder="${_e(TUT_DEFAULTS[k] || '值')}" data-cvi="${i}" data-cvf="v" />
          <button class="btn btn-xs btn-ghost text-error" data-cvi="${i}" data-cvf="del">x</button>
        </div>`).join("") || '<span class="opacity-30 text-xs">未覆盖任何键(全部用默认)</span>'}
      <datalist id="tp-cv-keys">${Object.keys(TUT_DEFAULTS).map(k => `<option value="${_e(k)}">`).join("")}</datalist>
    </div>`;
}

function _setTp(k, v) {
  if (!_cur) return;
  if (!_cur.parameters) _cur.parameters = {};
  if (!_cur.parameters.text_panel) _cur.parameters.text_panel = {};
  if (v == null || v === "") delete _cur.parameters.text_panel[k];
  else _cur.parameters.text_panel[k] = v;
  _syncPreviewVars();
}

function _bindTextPanelInputs() {
  const root = $("te-props"); if (!root) return;
  root.querySelectorAll("[data-tpc]").forEach(inp => inp.addEventListener("input", () => {
    _setTp(inp.dataset.tpc, inp.value);
    const lab = inp.closest("label")?.querySelector("i"); if (lab) lab.remove();
  }));
  root.querySelectorAll("[data-tpc-reset]").forEach(b => b.addEventListener("click", () => {
    _setTp(b.dataset.tpcReset, null); _renderProps();
  }));
  root.querySelectorAll("[data-tpr]").forEach(inp => inp.addEventListener("input", () => {
    const k = inp.dataset.tpr, unit = inp.dataset.unit;
    // pct=百分比滑条存0-1小数(engine的tp.opacity消费); num=纯数字; 其余带单位串
    const v = unit === "pct" ? Number(inp.value) / 100
      : unit === "num" ? Number(inp.value)
      : inp.value + (unit === "vw" ? "vw" : "px");
    _setTp(k, v);
    const lab = root.querySelector(`[data-tpr-val="${k}"]`);
    if (lab) lab.textContent = unit === "pct" ? inp.value + "%" : String(v);
  }));
  $("tp-style-reset")?.addEventListener("click", () => {
    if (_cur?.parameters) _cur.parameters.text_panel = {};
    _syncPreviewVars(); _renderProps();
  });
  $("tp-type-sound")?.addEventListener("change", (e) => { _setTp("type_sound", e.target.value || null); });
  // help_points编辑绑定
  $("tp-add-hp")?.addEventListener("click", () => {
    if (!_cur) return;
    if (!_cur.parameters) _cur.parameters = {};
    if (!_cur.parameters.help_points) _cur.parameters.help_points = [];
    _cur.parameters.help_points.push({ selector: "", label: "", story: "", trigger: "overlay_icon", position: "top-right" });
    _touch(); _renderProps();
  });
  root.querySelectorAll("[data-hpi]").forEach(el => {
    const i = Number(el.dataset.hpi), f = el.dataset.hpf;
    if (!_cur?.parameters?.help_points?.[i]) return;
    const hp = _cur.parameters.help_points;
    if (f === "del") { el.addEventListener("click", () => { hp.splice(i, 1); _touch(); _renderProps(); }); return; }
    if (f === "pick") { el.addEventListener("click", () => _startElementPick((sel) => { hp[i].selector = sel; _touch(); _renderProps(); })); return; }
    if (f === "size") {
      // "想把问号放明显一点"(凛倾124行批注): 图标宽高+字号同步缩放, 写hp.style(engine _createHelpIcon消费)
      el.addEventListener("change", () => {
        const n = parseInt(el.value, 10);
        if (n > 0) hp[i].style = { ...hp[i].style, size: n + "px", fontSize: Math.round(n * 0.55) + "px" };
        else if (hp[i].style) { delete hp[i].style.size; delete hp[i].style.fontSize; if (!Object.keys(hp[i].style).length) delete hp[i].style; }
        _touch();
      });
      return;
    }
    el.addEventListener("change", () => { hp[i][f] = el.value; _touch(); });
  });
  // 桌宠教程按钮(parameters.desk_button, engine _renderDeskButton消费; story引用已进_forEachRef)
  $("tp-db-on")?.addEventListener("change", (e) => {
    if (!_cur.parameters) _cur.parameters = {};
    if (e.target.checked) _cur.parameters.desk_button = { story: _cur.parameters.launch_story || _getBlocks()[0] || "" };
    else delete _cur.parameters.desk_button;
    _touch(); _renderProps();
  });
  const dbtn = _cur?.parameters?.desk_button;
  if (dbtn) {
    $("tp-db-label")?.addEventListener("change", (e) => { if (e.target.value) dbtn.label = e.target.value; else delete dbtn.label; _touch(); });
    $("tp-db-story")?.addEventListener("change", (e) => { dbtn.story = e.target.value; _touch(); _renderIssues(); });
    $("tp-db-pos")?.addEventListener("change", (e) => { dbtn.position = e.target.value; _touch(); });
  }
  // 变量定义(parameters.variables): 加/删/改初值; 不支持改名(删了重加), 删除提示引用失效风险
  $("tp-add-var")?.addEventListener("click", async () => {
    const { beiluPrompt } = await import("../../shared/widgets/beiluDialog.mjs");
    const n = ((await beiluPrompt("变量名(字母/数字/下划线, 如 trust):")) || "").trim();
    if (!/^\w+$/.test(n)) { if (n) window._beiluToast?.("变量名只能用字母/数字/下划线", "warning"); return; }
    if (!_cur.parameters) _cur.parameters = {};
    if (!_cur.parameters.variables) _cur.parameters.variables = {};
    if (_cur.parameters.variables[n] !== undefined) { window._beiluToast?.("已存在同名变量", "warning"); return; }
    _cur.parameters.variables[n] = 0;
    _touch(); _renderProps();
  });
  root.querySelectorAll("[data-tvi]").forEach(el => {
    const f = el.dataset.tvf;
    const tv = _cur?.parameters?.variables; if (!tv) return;
    const k0 = Object.keys(tv)[+el.dataset.tvi];
    if (k0 === undefined) return;
    if (f === "del") {
      el.addEventListener("click", async () => {
        const { beiluConfirm } = await import("../../shared/widgets/beiluDialog.mjs");
        if (!await beiluConfirm(`删除变量「${k0}」？\n引用它的选项显示条件/变量操作将失效(需手动清理)。`)) return;
        delete tv[k0];
        _touch(); _renderProps();
      });
      return;
    }
    el.addEventListener("change", () => {
      const num = Number(el.value);
      tv[k0] = el.value !== "" && Number.isFinite(num) ? num : el.value;
      _touch();
    });
  });
  // 高级视觉变量(css_vars): 改即 _syncPreviewVars 舞台实时生效
  $("tp-add-cv")?.addEventListener("click", async () => {
    const { beiluPrompt } = await import("../../shared/widgets/beiluDialog.mjs");
    const k = ((await beiluPrompt("CSS变量名(以--开头, 值框会提示出厂默认):", "--tut-")) || "").trim();
    if (!k.startsWith("--")) return;
    if (!_cur.parameters) _cur.parameters = {};
    if (!_cur.parameters.css_vars) _cur.parameters.css_vars = {};
    if (_cur.parameters.css_vars[k] === undefined) _cur.parameters.css_vars[k] = "";
    _touch(); _renderProps();
  });
  root.querySelectorAll("[data-cvi]").forEach(el => {
    const f = el.dataset.cvf;
    const cv = _cur?.parameters?.css_vars; if (!cv) return;
    const k0 = Object.keys(cv)[+el.dataset.cvi];
    if (k0 === undefined) return;
    if (f === "del") {
      el.addEventListener("click", () => {
        delete cv[k0];
        if (!Object.keys(cv).length) delete _cur.parameters.css_vars;
        _syncPreviewVars(); _renderProps();
      });
      return;
    }
    el.addEventListener("change", () => {
      if (f === "k") {
        const val = cv[k0]; delete cv[k0];
        const nk = el.value.trim();
        if (nk.startsWith("--")) cv[nk] = val;
        _renderProps();
      } else {
        cv[k0] = el.value;
      }
      _syncPreviewVars();
    });
  });
  $("tp-snd-test")?.addEventListener("click", () => {
    const v = $("tp-type-sound")?.value;
    if (!v) return;
    // 连播5声模拟打字感
    for (let i = 0; i < 5; i++) setTimeout(() => previewTypeSound(v), i * 70);
  });
}

// show_if 单源格式=字符串 "var op val"(engine._evalShowIf 唯一权威, 正则同构); 编辑器只做字符串的拆装
const _SIF_RE = SHOW_IF_RE;
function _parseSif(s) {
  const m = typeof s === "string" ? s.match(_SIF_RE) : null;
  return m ? [m[1], m[2], m[3]] : ["", "==", ""];
}
function _sifStr(varName, op, val) { return varName ? `${varName} ${op || "=="} ${val ?? ""}`.trim() : ""; }

// 立绘卡片: URL手填 或 图包级联选择(包→表情→文件, URL=/api/eye/user-images/<pack>/<file> 两段路由同 hitEditor)
function _renderArtCard(a, i) {
  const url = typeof a.url === "string" ? a.url : "";
  const packOpts = _packs.map(p => `<option value="${_e(p.name)}">${_e(p.name)}</option>`).join("");
  const pos = Array.isArray(a.position) ? a.position : ["0", "0", "0", "0"];
  return `
  <div class="te-choice-card">
    <div class="flex gap-1 items-center mb-1">
      <span class="font-bold text-xs opacity-40">#${i}</span>
      <input class="input input-xs input-bordered flex-1" value="${_e(url)}" placeholder="${a.pack ? _e(`📦 ${a.pack} · ${a.expr}(图包引用)`) : "图片URL(或用下方图包选)"}" data-ai="${i}" />
      <button class="btn btn-xs btn-ghost text-error" data-adel="${i}">x</button>
    </div>
    <div class="flex gap-1 items-center">
      <select class="select select-xs select-bordered flex-1" data-apack="${i}"><option value="">图包...</option>${packOpts}</select>
      <select class="select select-xs select-bordered flex-1" data-aexpr="${i}" disabled><option value="">表情...</option></select>
    </div>
    <div class="te-prop-row mt-1"><label>大小(等比缩放) <span class="opacity-60" data-aslabel="${i}">${_e(Array.isArray(a.size) ? a.size[0] || "40%" : "40%")}</span></label>
      <input type="range" min="5" max="100" step="0.5" value="${parseFloat(Array.isArray(a.size) ? a.size[0] : "40") || 40}" class="range range-xs range-warning" data-ascale="${i}" /></div>
    <div class="grid grid-cols-2 gap-1 mt-1">
      <label class="text-[10px] opacity-60">左<input class="input input-xs input-bordered w-full" value="${_e(pos[0])}" data-apos="${i}" data-pi="0" /></label>
      <label class="text-[10px] opacity-60">上<input class="input input-xs input-bordered w-full" value="${_e(pos[2])}" data-apos="${i}" data-pi="2" /></label>
    </div>
    <div class="te-prop-row mt-1"><label>动作(进入此对话时播, 立绘运动系统)</label>
      <select class="select select-xs select-bordered w-full" data-amotion="${i}">
        <option value="">无</option>
        <option value="enter" ${a.motion === 'enter' ? 'selected' : ''}>入场(淡入上浮)</option>
        <option value="shake" ${a.motion === 'shake' ? 'selected' : ''}>震动</option>
        <option value="bounce" ${a.motion === 'bounce' ? 'selected' : ''}>弹跳</option>
        <option value="leave" ${a.motion === 'leave' ? 'selected' : ''}>退场(淡出移除)</option>
      </select></div>
    <div class="text-[10px] opacity-40 mt-0.5">画布上直接拖动移动 · 拖右下圆点或拉条缩放</div>
  </div>`;
}

function _renderChoiceCard(c, i, blocks, vars) {
  const text = typeof c.text === "string" ? c.text : "";
  return `
  <div class="te-choice-card">
    <div class="te-choice-header">
      <span class="font-bold text-xs opacity-40">#${i}</span>
      <input class="input input-xs input-bordered flex-1" value="${_e(text)}" placeholder="选项文字" data-ci="${i}" data-cf="text" />
      <button class="btn btn-xs btn-ghost text-error" data-ci="${i}" data-cf="del">x</button>
    </div>
    <div class="te-prop-row"><label>选了这个选项后去哪</label>
      <select class="select select-xs select-bordered w-full" data-ci="${i}" data-cf="go_to">
        <option value="">继续(下一对话)</option>
        <option value="tue_go" ${c.go_to === 'tue_go' ? 'selected' : ''}>下一场景</option>
        ${blocks.map(b => `<option value="${_e(b)}" ${c.go_to === b ? 'selected' : ''}>线路: ${_e(b)}</option>`).join("")}
        <option value="__new__">＋ 新建分支线(以选项文字命名)…</option>
      </select></div>
    <div class="te-choice-trigger">
      <div class="flex gap-1 items-center">
        <span class="opacity-50">显示条件:</span>
        <select class="select select-xs select-bordered w-16" data-ci="${i}" data-cf="sif_var">
          <option value="">无</option>${vars.map(v => `<option value="${_e(v)}" ${_parseSif(c.show_if)[0] === v ? 'selected' : ''}>${_e(v)}</option>`).join("")}
        </select>
        <select class="select select-xs select-bordered w-14" data-ci="${i}" data-cf="sif_op">
          ${["==", "!=", ">", "<", ">=", "<="].map(op => `<option value="${op}" ${_parseSif(c.show_if)[1] === op ? 'selected' : ''}>${op.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</option>`).join("")}
        </select>
        <input class="input input-xs input-bordered w-12" value="${_e(_parseSif(c.show_if)[2])}" data-ci="${i}" data-cf="sif_val" />
      </div>
      <div class="flex gap-1 items-center mt-1">
        <span class="opacity-50">点击改变:</span>
        <select class="select select-xs select-bordered w-16" data-ci="${i}" data-cf="cv_var">
          <option value="">-</option>${vars.map(v => `<option value="${_e(v)}" ${c.variables?.[0]?.[0] === v ? 'selected' : ''}>${_e(v)}</option>`).join("")}
        </select>
        <select class="select select-xs select-bordered w-12" data-ci="${i}" data-cf="cv_op">
          <option value="set">set</option><option value="add" ${c.variables?.[0]?.[1] === 'add' ? 'selected' : ''}>add</option>
        </select>
        <input class="input input-xs input-bordered w-12" value="${_e(c.variables?.[0]?.[2] ?? '')}" data-ci="${i}" data-cf="cv_val" />
      </div>
    </div>
  </div>`;
}

function _renderChoiceProps(idx) {
  // 选中画布上的选项 → 高亮对应的选项卡片
  const cards = $("tp-choices")?.querySelectorAll(".te-choice-card");
  cards?.forEach((c, i) => c.style.outline = i === idx ? "2px solid var(--color-warning)" : "none");
}

// ── 属性面板事件绑定 ──

function _bindProps(dlg, blocks, vars) {
  $("tp-name")?.addEventListener("change", (e) => { dlg.name = e.target.value; _renderCanvas(); _renderDialogList(); });
  $("tp-text")?.addEventListener("input", (e) => { dlg.text = e.target.value; _renderCanvas(); _renderDialogList(); });
  $("tp-goto")?.addEventListener("change", async (e) => {
    if (e.target.value === "__new__") {
      const n = await _newLineViaPrompt();
      if (n) { dlg.go_to = n; _selBlock = n; _selScene = 0; _selDialog = 0; _renderAll(); }
      else _renderProps(); // 取消/非法名: 下拉还原
      return;
    }
    dlg.go_to = e.target.value || undefined; _renderDialogList(); _renderIssues();
  });
  $("tp-timer")?.addEventListener("change", (e) => { const ms = +e.target.value; dlg.timer = ms > 0 ? [ms, "tue_go"] : undefined; });
  $("tp-effect")?.addEventListener("change", (e) => {
    if (e.target.value) dlg.event = e.target.value; else delete dlg.event;
    _touch();
  });
  $("tp-pick")?.addEventListener("click", () => _startElementPick((sel) => {
    dlg.await_click = sel;
    _renderProps(); _renderDialogList();
  }));
  $("tp-pick-clear")?.addEventListener("click", () => {
    delete dlg.await_click;
    _renderProps(); _renderDialogList();
  });
  $("tp-del-dlg")?.addEventListener("click", () => {
    const scene = _getScene(); if (!scene?.dialogs) return;
    scene.dialogs.splice(_selDialog, 1);
    if (_selDialog >= scene.dialogs.length) _selDialog = Math.max(0, scene.dialogs.length - 1);
    _renderAll();
  });

  // controll区绑定
  for (const [inputId, key] of [["tp-ctrl-pack", "pack"], ["tp-ctrl-emotion", "emotion"], ["tp-ctrl-tab", "tab"]]) {
    $(inputId)?.addEventListener("change", (e) => {
      if (!dlg.controll) dlg.controll = {};
      if (e.target.value) dlg.controll[key] = e.target.value;
      else { delete dlg.controll[key]; if (!Object.keys(dlg.controll).length) delete dlg.controll; }
      _touch();
    });
  }

  // 放大对话框
  $("tp-expand-text")?.addEventListener("click", () => {
    const ta = $("tp-text"); if (!ta) return;
    const expanded = ta.rows > 4;
    ta.rows = expanded ? 4 : 16;
    ta.style.fontSize = expanded ? "" : "14px";
  });

  // 立绘
  $("tp-add-art")?.addEventListener("click", () => {
    if (!dlg.art) dlg.art = [];
    dlg.art.push({ url: "", size: _artDefaultSize(), position: _artDefaultPos() });
    _renderProps(); _renderCanvas();
  });
  $("tp-arts")?.querySelectorAll("[data-ai]").forEach(i => i.addEventListener("change", () => {
    const a = (dlg.art || [])[+i.dataset.ai]; if (!a) return;
    // 手填url=显式覆盖, 清pack引用防双源歧义; 清空且有pack引用=回到引用
    if (i.value) { a.url = i.value; delete a.pack; delete a.expr; }
    else delete a.url;
    _renderCanvas(); _renderProps();
  }));
  $("tp-arts")?.querySelectorAll("[data-adel]").forEach(b => b.addEventListener("click", () => {
    dlg.art?.splice(+b.dataset.adel, 1); if (!dlg.art?.length) delete dlg.art;
    _renderProps(); _renderCanvas();
  }));
  // 图包级联: 包→表情(启用第二级) / 表情→写url(多文件取首张; 运行时同表情多张随机是桌宠机制, 教程立绘定张)
  $("tp-arts")?.querySelectorAll("[data-apack]").forEach(sel => sel.addEventListener("change", () => {
    const i = +sel.dataset.apack;
    const exprSel = $("tp-arts").querySelector(`[data-aexpr="${i}"]`);
    const pack = _packs.find(p => p.name === sel.value);
    if (!exprSel) return;
    if (!pack) { exprSel.disabled = true; exprSel.innerHTML = '<option value="">表情...</option>'; return; }
    exprSel.disabled = false;
    exprSel.innerHTML = '<option value="">表情...</option>' + Object.keys(pack.expressions || {}).map(x =>
      `<option value="${_e(x)}">${_e(x)}</option>`).join("");
  }));
  $("tp-arts")?.querySelectorAll("[data-aexpr]").forEach(sel => sel.addEventListener("change", () => {
    const i = +sel.dataset.aexpr;
    const packName = $("tp-arts").querySelector(`[data-apack="${i}"]`)?.value;
    const a = dlg.art?.[i];
    if (!packName || !sel.value || !a) return;
    // pack+expr语义引用(与画布图包浮窗同写法): 图包更新教程自动跟随
    delete a.url;
    a.pack = packName;
    a.expr = sel.value;
    _renderProps(); _renderCanvas();
  }));
  // 等比缩放拉条(凛倾0715: "需要一个拉条,可以进行等比缩小或者放大") — 写点=art.size[0]%, 高auto等比
  $("tp-arts")?.querySelectorAll("[data-ascale]").forEach(inp => inp.addEventListener("input", () => {
    const a = dlg.art?.[+inp.dataset.ascale]; if (!a) return;
    a.size = [inp.value + "%", "auto"];
    const lab = $("tp-arts").querySelector(`[data-aslabel="${inp.dataset.ascale}"]`);
    if (lab) lab.textContent = inp.value + "%";
    // 舞台实时应用(不重渲整段, 直接改engine元素)
    const el = document.querySelector(`#tut-art-layer .tut-art[data-art-id="${inp.dataset.ascale}"]`);
    if (el) applyArtLayout(el, a);
    _touch();
  }));
  // 立绘动作(art.motion: engine声明式运动系统消费, enter仅新建时播/其余每次触发)
  $("tp-arts")?.querySelectorAll("[data-amotion]").forEach(sel => sel.addEventListener("change", () => {
    const a = dlg.art?.[+sel.dataset.amotion]; if (!a) return;
    if (sel.value) a.motion = sel.value; else delete a.motion;
    _renderCanvas(); // 编辑态重渲即预览动作(shake/bounce即时可见)
  }));
  // 位置/尺寸数值可调(与拖拽同一写点 art.position/art.size, tuesday-js数组格式)
  $("tp-arts")?.querySelectorAll("[data-apos]").forEach(inp => inp.addEventListener("change", () => {
    const a = dlg.art?.[+inp.dataset.apos]; if (!a) return;
    if (!Array.isArray(a.position)) a.position = ["0", "0", "0", "0"];
    a.position[+inp.dataset.pi] = inp.value || "0";
    _renderCanvas();
  }));
  $("tp-arts")?.querySelectorAll("[data-asz]").forEach(inp => inp.addEventListener("change", () => {
    const a = dlg.art?.[+inp.dataset.asz]; if (!a) return;
    if (!Array.isArray(a.size)) a.size = ["", ""];
    a.size[+inp.dataset.pi] = inp.value;
    _renderCanvas();
  }));

  // 选项
  $("tp-add-choice")?.addEventListener("click", () => { _addChoice(dlg); });
  _bindChoiceEvents(dlg, blocks, vars);

  // 对话框样式(text_panel): 空值=删键回默认
  _bindTextPanelInputs();

  // 变量操作
  $("tp-add-vop")?.addEventListener("click", () => {
    if (!dlg.variables) dlg.variables = [];
    dlg.variables.push(["", "set", ""]);
    _renderProps();
  });
  _bindVopEvents(dlg, vars);
}

function _bindChoiceEvents(dlg, blocks, vars) {
  const el = $("tp-choices"); if (!el) return;
  const ch = dlg.choice || [];
  el.querySelectorAll("[data-cf]").forEach(inp => {
    const h = () => {
      const i = +inp.dataset.ci, f = inp.dataset.cf;
      if (f === "del") { ch.splice(i, 1); dlg.choice = ch.length ? ch : undefined; _renderProps(); _renderCanvas(); return; }
      if (f === "text") { ch[i].text = inp.value; _renderCanvas(); }
      if (f === "go_to") {
        if (inp.value === "__new__") { delete ch[i].go_to; _gotoChoiceBranch(ch[i]); return; } // 建线并进入写内容
        if (inp.value) ch[i].go_to = inp.value; else delete ch[i].go_to;
        _renderIssues();
      }
      // show_if=字符串单源格式(engine._evalShowIf同构), 三控件拆装同一条字符串
      if (f === "sif_var") { const s = _parseSif(ch[i].show_if); const v = _sifStr(inp.value, s[1], s[2]); if (v) ch[i].show_if = v; else delete ch[i].show_if; }
      if (f === "sif_op") { const s = _parseSif(ch[i].show_if); if (s[0]) ch[i].show_if = _sifStr(s[0], inp.value, s[2]); }
      if (f === "sif_val") { const s = _parseSif(ch[i].show_if); if (s[0]) ch[i].show_if = _sifStr(s[0], s[1], inp.value); }
      if (f === "cv_var") { if (inp.value) ch[i].variables = [[inp.value, "set", ch[i].variables?.[0]?.[2] || ""]]; else delete ch[i].variables; }
      if (f === "cv_op" && ch[i].variables) ch[i].variables[0][1] = inp.value;
      if (f === "cv_val" && ch[i].variables) ch[i].variables[0][2] = inp.value;
    };
    inp.addEventListener(inp.tagName === "BUTTON" ? "click" : "change", h);
  });
}

function _bindVopEvents(dlg, vars) {
  const el = $("tp-vops"); if (!el) return;
  const ops = dlg.variables || [];
  el.querySelectorAll("[data-vf]").forEach(inp => {
    const h = () => {
      const i = +inp.dataset.vi, f = inp.dataset.vf;
      if (f === "del") { ops.splice(i, 1); dlg.variables = ops.length ? ops : undefined; _renderProps(); return; }
      if (f === "name") ops[i][0] = inp.value;
      if (f === "op") ops[i][1] = inp.value;
      if (f === "val") ops[i][2] = inp.value;
    };
    inp.addEventListener(inp.tagName === "BUTTON" ? "click" : "change", h);
  });
}

const _e = escTutHtml;

window._beiluTutorialPanel = { open: openTutorialPanel, close: closeTutorialPanel, toggle: toggleTutorialPanel };

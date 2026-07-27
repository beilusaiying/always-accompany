/**
 * panels.mjs — 编辑界面内联面板加载器 cluster
 *
 * 功能链：用户打开编辑弹窗（AIRP）对应 Tab → 各 loader 按需调用（懒加载，仅首次渲染）
 *   → _loadPersonaEditor() 拉取 /api/getallcacheddetails/personas 渲染人设卡片（保存/激活/删除）
 *   → _loadPresetPanel() 拉取预设列表渲染选择器
 *   → _loadInjPanel() 加载注入规则编辑器（Tab4 内联，旧浮窗已删）
 *   → _loadWorldbookInline() 加载世界书内联编辑（Tab2 内联，旧浮窗已删）
 *   → _openCharEditDialog() 弹出角色卡编辑对话框
 * why：所有编辑界面面板统一从浮窗迁移到 AIRP Tab 内联，集中在此 cluster 管理加载逻辑，
 *   避免各调用方重复实现懒加载和 API 拉取
 * 关联链：被 settings.mjs（_initSettingsModals 中调用）和 charsel.mjs（_openCharEditDialog）import；
 *   import api-client.mjs（人设/预设数据读写）、utils.mjs（头像解析）、beiluDialog.mjs（确认框）
 * 影响范围：改动影响人设编辑（保存/激活/删除）、预设面板、注入规则、世界书内联编辑、角色卡编辑对话框
 * 使用效果：用户打开「编辑」弹窗切到「人设」Tab，首次自动加载人设列表，可直接编辑描述并保存激活
 */
import { escapeHtml, DEFAULT_AVATAR, resolveAvatar, positionContextMenu, bindClickOutsideClose } from "../../shared/state/utils.mjs"; // [合并批 0714·二] 点外关闭收口单源
import { sendAction } from "../../shared/transport/sendAction.mjs"; // T6b：出向统一门面（preset/worldbook 字段写；memory 通配注 _action；chars/persona 专用路由）
import { openInjectDock } from "../../shared/chat-core/injectDock.mjs"; // 0726：INJ 面板「单次注入」入口→注入坞（同一功能不做第二份 UI）
import { currentChatId } from "../../shared/transport/endpoints.mjs"; // 预设条目 Inspect：getFakeSend 需 chatId（live-binding 单源，endpoints.mjs:36）
import { storage, KEYS } from "../../shared/state/storage.mjs";
import { showToast } from "../../../../../../../scripts/toast.mjs";
import { beiluConfirm, beiluPrompt } from "../../shared/widgets/beiluDialog.mjs";
import { enableDragAutoScroll } from "../../shared/widgets/dragAutoScroll.mjs"; // 0722：拖拽排序中 wheel 被浏览器抑制→边缘自动滚动
import { recordImportHistory } from "./importExport.mjs"; // T033：预设导入成功上报集中历史
import { classifyPresetName, PRESET_CATEGORIES, PRESET_CATEGORY_LABELS } from "../airp/preset.mjs"; // [0713 单源化] 预设分类判定唯一实现（含 bucket 权威链）；[0716] 分类集合/标签同源
// openInjEditor浮窗已删除，INJ统一到编辑界面Tab4
const _escHtml = escapeHtml; // panels 用的共享 alias（layout.mjs:24 同名,不随迁,此处自备）

// W61: Persona用户人设编辑器（AIRP Tab内）
async function _loadPersonaEditor() {
  const container = document.getElementById("airp-persona-container");
  if (!container) return;
  container.innerHTML = '<p class="text-xs text-base-content/40">加载中...</p>';

  try {
    // 原 raw GET /api/getallcacheddetails/personas + res.ok 手检 → 门面 getAllCached（payload.type 进 URL）；!ok 由门面抛错走 catch
    const result = await sendAction({ verb: "getAllCached", target: "server:details", source: "web", payload: { type: "personas" } });
    const cachedDetails = result?.cachedDetails || {};
    const uncachedNames = result?.uncachedNames || [];
    const allNames = [...Object.keys(cachedDetails), ...uncachedNames];

    if (allNames.length === 0) {
      container.innerHTML = '<p class="text-sm opacity-40">暂无用户人设</p>';
    } else {
      container.innerHTML = "";
      allNames.forEach(name => {
        const details = cachedDetails[name]?.info || cachedDetails[name] || {};
        const desc = details.description || "";
        const displayName = (typeof details.name === "string" ? details.name : details.name?.["zh-CN"] || name) || name;
        // C7 统一契约：空串/缺失/宏均显式 fallback；有值则解析路径并加缓存破坏参数
        const _resolved = resolveAvatar({ avatar: details.avatar, kind: "personas", name });
        const avatarUrl = _resolved === DEFAULT_AVATAR
          ? DEFAULT_AVATAR
          : `${_resolved}${_resolved.includes("?") ? "&" : "?"}t=${Date.now()}`;

        const card = document.createElement("div");
        card.className = "border border-base-content/10 rounded-lg p-3 mb-3";
        card.style.background = "oklch(var(--bc) / 0.03)";
        card.innerHTML = `
          <div class="flex items-start gap-3">
            <img src="${_escHtml(avatarUrl)}" class="w-12 h-12 rounded-full object-cover shrink-0" onerror="this.onerror=null;this.style.display='none';this.insertAdjacentHTML('afterend','<div class=&quot;w-12 h-12 rounded-full bg-base-300 flex items-center justify-center text-lg shrink-0&quot;>👤</div>')"/>
            <div class="flex-1 min-w-0">
              <div class="font-bold text-sm">${_escHtml(displayName)}</div>
              <textarea class="textarea textarea-bordered w-full text-xs mt-1" style="min-height:60px;" data-persona="${_escHtml(name)}">${_escHtml(desc)}</textarea>
              <div class="flex gap-2 mt-1">
                <button class="btn btn-xs btn-primary persona-save-btn" data-persona="${_escHtml(name)}">💾 保存</button>
                <button class="btn btn-xs btn-outline persona-activate-btn" data-persona="${_escHtml(name)}"><i data-ic="drama"></i> 激活</button>
                <button class="btn btn-xs btn-ghost text-error persona-delete-btn" data-persona="${_escHtml(name)}" title="删除此人设"><i data-ic="trash"></i></button>
              </div>
            </div>
          </div>
        `;
        container.appendChild(card);
      });

      // 保存按钮
      container.querySelectorAll(".persona-save-btn").forEach(btn => {
        btn.addEventListener("click", async () => {
          const name = btn.dataset.persona;
          const textarea = container.querySelector(`textarea[data-persona="${name}"]`);
          if (!textarea) return;
          try {
            const formData = new FormData();
            formData.append("description", textarea.value);
            // 原 raw PUT persona/${name}/update（FormData）+ res.ok 手检 → 门面 updatePersona（payload.personaName 进 URL，formData 直传（复用分身S updatePersona））；!ok 由门面抛错走 catch
            await sendAction({ verb: "updatePersona", target: "shells:chat", source: "web", payload: { personaName: name, formData } });
            btn.textContent = "✅ 已保存"; setTimeout(() => { btn.textContent = "💾 保存"; }, 1500);
          } catch (e) {
            btn.textContent = "❌ 失败";
            console.error("[persona] 保存失败:", e);
            window._reportError?.(`[layout] persona save error: ${e.message}`);
          }
        });
      });

      // 激活按钮：后端apply + 本地同步（不依赖WS回调延迟）
      container.querySelectorAll(".persona-activate-btn").forEach(btn => {
        btn.addEventListener("click", async () => {
          const name = btn.dataset.persona;
          try {
            const { setPersona } = await import("../../shared/transport/endpoints.mjs");
            const { setPersonaName } = await import("../../shared/chat-core/chat.mjs");
            await setPersona(name);
            setPersonaName(name);
            btn.textContent = "✅ 已激活";
            setTimeout(() => { btn.innerHTML = '<i data-ic="drama"></i> 激活'; }, 1500);
          } catch (e) {
            console.error("[persona] 激活失败:", e);
            window._reportError?.(`[layout] persona activate error: ${e.message}`);
          }
        });
      });

      // 删除按钮
      container.querySelectorAll(".persona-delete-btn").forEach(btn => {
        btn.addEventListener("click", async () => {
          const name = btn.dataset.persona;
          const ok = await beiluConfirm(`确定要删除人设「${name}」吗？此操作不可撤销。`);
          if (!ok) return;
          try {
            // 原 raw DELETE persona/${name} + res.ok 手检（读 d.message）→ 门面 deletePersona（payload._name 进 URL）；!ok 由门面抛错（apiFetch 已解析 body.error）走 catch
            await sendAction({ verb: "deletePersona", target: "shells:chat", source: "web", payload: { _name: name } });
            showToast("success", `人设「${name}」已删除`);
            _loadPersonaEditor();
          } catch (e) {
            showToast("error", `删除失败: ${e.message}`);
            console.error("[persona] 删除失败:", e);
          }
        });
      });
    }

    // 新建按钮
    const newBtn = document.createElement("button");
    newBtn.className = "btn btn-sm btn-outline btn-warning mt-2";
    newBtn.innerHTML = '<i data-ic="sparkles"></i> 新建人设';
    newBtn.addEventListener("click", async () => {
      const name = await beiluPrompt("人设名称:");
      if (!name) return;
      try {
        const formData = new FormData();
        formData.append("name", name);
        formData.append("description", "");
        // 原 raw POST persona/create（FormData）+ res.ok 手检 → 门面 createPersona（payload._form=FormData 直传）；!ok 由门面抛错走 catch
        await sendAction({ verb: "createPersona", target: "shells:chat", source: "web", payload: { _form: formData } });
        _loadPersonaEditor(); // 重新加载
      } catch (e) {
        console.error("[persona] 创建失败:", e);
        window._reportError?.(`[layout] persona create error: ${e.message}`);
      }
    });
    container.appendChild(newBtn);

  } catch (e) {
    console.error("[layout] loadPersonaEditor error:", e);
    window._reportError?.(`[layout] loadPersonaEditor error: ${e.message}`);
    container.innerHTML = `<p class="text-sm text-error">加载失败: ${e.message}</p>`;
  }
}

// 界面8: W61 旧版 _loadGitCheckpointPanel 已删（零外部调用死码；Git 快照唯一权威=MEM-T4 快照管理双 section 版 #mem-git-list）

// W63: 预设面板（完整编辑器 + 拖拽排序 + 条目编辑）
async function _loadPresetPanel() {
  const container = document.getElementById("airp-preset-container");
  if (!container) return;
  container.innerHTML = '<p class="text-xs text-base-content/40">加载中...</p>';

  const MARKERS = ["personaDescription","charDescription","charPersonality","scenario","worldInfoBefore","worldInfoAfter","chatHistory","dialogueExamples","enhanceDefinitions"];
  const MARKER_NAMES = { personaDescription:"用户设定", charDescription:"角色描述", charPersonality:"角色性格", scenario:"场景", worldInfoBefore:"世界书(前)", worldInfoAfter:"世界书(后)", chatHistory:"聊天历史", dialogueExamples:"对话示例", enhanceDefinitions:"增强定义" };
  try {
    // 原 raw GET preset getdata → 复用 getData；!ok 由门面抛错走外层 catch
    const presetData = await sendAction({ verb: "getData", target: "plugins:beilu-preset", source: "web" });
    const presets = presetData?.preset_list || [];
    // let（原 const）：#pp-activate 切换成功后同步，供条目 Inspect 判断"浏览中预设是否为激活预设"不 stale
    let activePreset = (window._beiluResolveActivePreset?.(presetData) ?? presetData?.active_preset) || "";
    // Inspect 的对话锚点：activePreset 是按「面板打开时的对话」解析的（getData 桥注入当时 hash 的 chatid）。
    // 弹窗开着时浏览器后退切对话（hashchange 不关弹窗）→ currentChatId 已变而 activePreset 仍是旧对话的
    // → 激活判断会放行按新对话激活预设组装的内容=张冠李戴。故记录打开时刻对话，Inspect 时实时比对。
    const panelChatId = window._beiluGetChatId?.() || "";
    if (presets.length === 0) { container.innerHTML = '<p class="text-sm opacity-40">暂无预设</p>'; return; }

    // 预设分类: 用户自定义覆盖 > 名称关键词自动归类
    const _CAT_KEY = KEYS.BEILU_PRESET_CATEGORIES;
    const _CAT_LIST_KEY = KEYS.BEILU_PRESET_CATEGORIES_LIST;
    // [0716] 内置分类集合单源=airp/preset.mjs PRESET_CATEGORIES（chat/code/work/clone/bot/ppt）
    const BUILTIN_CATS = PRESET_CATEGORIES;
    // 内置分类的显示标签（带 emoji），选择/tab 文字统一从此表读，与选择器分组同源
    const _catLabel = (c) => (PRESET_CATEGORY_LABELS[c] || c);
    const _loadCategories = () => { try { return JSON.parse(storage.get(_CAT_KEY) || "{}"); } catch { return {}; } };
    const _saveCategories = (cats) => storage.set(_CAT_KEY, JSON.stringify(cats));
    const _loadCatList = () => { try { return JSON.parse(storage.get(_CAT_LIST_KEY) || "[]"); } catch { return []; } };
    const _saveCatList = (list) => storage.set(_CAT_LIST_KEY, JSON.stringify(list));
    // [0713 单源化] 分类判定唯一实现 = airp/preset.mjs classifyPresetName（含后端 registry bucket 权威链）。
    // 原本地副本缺 bucket 链 → 分身预设兜底进聊天，本面板分类数与预设选择器对不上（聊天6vs2/编程12vs16）。
    const classifyPreset = classifyPresetName;
    const customCats = _loadCatList(); // 用户自定义分类名列表
    let currentFilter = 'all'; // all|chat|code|work|自定义分类名

    // Build UI
    container.innerHTML = `
      <div class="flex flex-col gap-2 h-full">
        <!-- 分类筛选 -->
        <div class="tabs tabs-boxed tabs-xs bg-base-200/50 flex-wrap" id="pp-filter-tabs">
          <button class="tab tab-active pp-filter-tab" data-filter="all">全部 <span class="badge badge-xs ml-1">${presets.length}</span></button>
          ${BUILTIN_CATS.map(c => `<button class="tab pp-filter-tab" data-filter="${_escHtml(c)}">${_escHtml(_catLabel(c))} <span class="badge badge-xs ml-1">${presets.filter(n=>classifyPreset(n)===c).length}</span></button>`).join('')}
          ${customCats.map(c => `<button class="tab pp-filter-tab pp-custom-cat" data-filter="${_escHtml(c)}">${_escHtml(c)} <span class="badge badge-xs ml-1">${presets.filter(n=>classifyPreset(n)===c).length}</span><span class="pp-cat-del ml-0.5 cursor-pointer opacity-40 hover:opacity-100 hover:text-error" data-cat="${_escHtml(c)}" title="删除分类">✕</span></button>`).join('')}
          <button class="tab pp-add-cat-btn opacity-50 hover:opacity-100" title="添加自定义分类">＋</button>
        </div>
        <!-- 预设选择 -->
        <div class="flex items-center gap-1 flex-wrap">
          <select id="pp-preset-sel" class="select select-xs select-bordered flex-1 min-w-[120px]">
            ${(() => {
              // [0716 凛倾「没有起到分类作用,可以直接删除…上面已经有分类了,完全多此一举」] 本下拉零 optgroup，
              //   平铺 option：分类职责单源在正上方 pp-filter-tabs；optgroup 标题行不受 option.hidden 影响
              //   （_applyFilter 只藏 option）→ 筛选后标题全数残留成"点不动的死行"，被误认成选项。
              //   仅保留按分类聚簇的排序（同类相邻可扫读）；data-category 供 _applyFilter/_refreshCatBadges 过滤零改。
              const byPri = {};
              presets.forEach((n) => { const p = classifyPreset(n); (byPri[p] = byPri[p] || []).push(n); });
              const priOrder = [...BUILTIN_CATS, ...customCats, ...Object.keys(byPri).filter((k) => !BUILTIN_CATS.includes(k) && !customCats.includes(k))];
              const buildOpt = (n) => `<option value="${_escHtml(n)}" data-category="${classifyPreset(n)}" ${(presetData?.preset_descriptions?.[n]) ? `title="${_escHtml(presetData.preset_descriptions[n])}"` : ''} ${n===activePreset?'selected':''}>${_escHtml(n.replace(/\.json$/i,''))}${n===activePreset?' ✓':''}</option>`;
              return priOrder.map((pri) => (byPri[pri] || []).map(buildOpt).join('')).join('');
            })()}
          </select>
          <button id="pp-activate" class="btn btn-xs btn-warning" title="绑定到当前模式并应用">🎯</button>
          <button id="pp-new" class="btn btn-xs btn-success" title="新建">＋</button>
          <button id="pp-dup" class="btn btn-xs btn-info" title="复制"><i data-ic="clipboard"></i></button>
          <button id="pp-rename" class="btn btn-xs btn-ghost" title="重命名"><i data-ic="edit"></i></button>
          <button id="pp-desc" class="btn btn-xs btn-ghost" title="编辑描述（标注适用场景）">✎</button>
          <button id="pp-del" class="btn btn-xs btn-error" title="删除"><i data-ic="trash"></i></button>
          <button id="pp-import" class="btn btn-xs btn-ghost" title="导入">↓</button>
          <button id="pp-export" class="btn btn-xs btn-ghost" title="导出">↑</button>
          <select id="pp-category" class="select select-xs select-bordered text-[10px] ml-1" title="模式归档">
            <option value="">自动</option>
            ${BUILTIN_CATS.map(c => `<option value="${_escHtml(c)}">${_escHtml(_catLabel(c))}</option>`).join('')}
            ${customCats.map(c => `<option value="${_escHtml(c)}">${_escHtml(c)}</option>`).join('')}
          </select>
        </div>
        <div id="pp-stats" class="text-[10px] opacity-40"></div>
        <!-- 搜索 -->
        <input id="pp-search" class="input input-xs input-bordered w-full" placeholder="搜索条目..." />
        <!-- 主体: 条目列表 + 拖拽分隔条 + 详情 -->
        <div class="flex" style="flex:1;min-height:0;">
          <div id="pp-entry-list" class="flex flex-col gap-0.5 overflow-y-auto pr-1" style="width:45%;"></div>
          <div id="pp-split" class="flex-none bg-base-content/10 hover:bg-warning/50 rounded mx-1" style="width:5px;cursor:col-resize;touch-action:none;" title="拖动调整宽度"></div>
          <div id="pp-entry-detail" class="flex-1 overflow-y-auto pl-1 min-w-0">
            <p class="text-xs opacity-50 mt-8 text-center">未选择条目。点击左侧条目查看详情</p>
          </div>
        </div>
        <!-- 底部操作 -->
        <div class="flex gap-1">
          <button id="pp-add-entry" class="btn btn-xs btn-outline btn-success">＋ 添加条目</button>
          <button id="pp-open-inj" class="btn btn-xs btn-outline btn-warning"><i data-ic="syringe"></i> 打开注入提示词编辑器</button>
        </div>
      </div>
    `;

    // 分栏拖拽: #pp-split 左右拖动调整列表/详情宽度比,持久化到 storage(15%~80% 夹取)
    {
      const splitEl = container.querySelector('#pp-split');
      const listEl = container.querySelector('#pp-entry-list');
      const savedW = parseFloat(storage.get(KEYS.BEILU_PRESET_SPLIT));
      if (savedW >= 15 && savedW <= 80) listEl.style.width = savedW + '%';
      enableDragAutoScroll(listEl); // 0722：长列表拖拽排序可越过可视区（wheel 在 DnD 中被浏览器抑制）
      splitEl.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        splitEl.setPointerCapture(ev.pointerId);
        const wrap = splitEl.parentElement;
        const onMove = (e) => {
          const rect = wrap.getBoundingClientRect();
          const pct = Math.min(80, Math.max(15, (e.clientX - rect.left) / rect.width * 100));
          listEl.style.width = pct.toFixed(1) + '%';
        };
        const onUp = () => {
          splitEl.removeEventListener('pointermove', onMove);
          splitEl.removeEventListener('pointerup', onUp);
          splitEl.removeEventListener('pointercancel', onUp);
          storage.set(KEYS.BEILU_PRESET_SPLIT, parseFloat(listEl.style.width).toFixed(1));
        };
        splitEl.addEventListener('pointermove', onMove);
        splitEl.addEventListener('pointerup', onUp);
        splitEl.addEventListener('pointercancel', onUp);
      });
    }

    let currentPresetName = container.querySelector('#pp-preset-sel').value;
    let entries = [];
    let selectedId = null;
    // [0724 多选拖拽] Ctrl/⌘+点击多选（存条目 key=identifier||name||entry_idx）；普通点击/切换预设清空。
    // draggedIds=本次拖拽携带的条目组：拖多选成员=整组随动（保持相对顺序），拖非成员=只拖单条（不清多选）。
    let multiSelIds = new Set();
    let draggedIds = [];

    // 原 raw POST preset setdata（字段分派，不吃 _action）→ 复用 updatePresetConfig（body=payload 直传）；返回门面已解析体（调用方不再 .json()）。
    const postApi = (body) => sendAction({ verb: "updatePresetConfig", target: "plugins:beilu-preset", source: "web", payload: body });

    // Load entries: 用 getdata?preset=X 直接获取指定预设的entries（后端 getEngineFor 懒加载，不改全局状态）
    // 不调 switch_preset — 浏览预设只是查看，不应改变全局激活状态
    const loadEntries = async () => {
      try {
        // 原 raw GET getdata?preset=X → 门面 getDataForPreset（payload.preset 进 query）；!ok 由门面抛错走 catch
        const d = await sendAction({ verb: "getDataForPreset", target: "plugins:beilu-preset", source: "web", payload: { preset: currentPresetName } });
        // [预设切换互斥 2026-07-13 读互斥] 后端不再静默回退主引擎：请求预设不存在时返回 error+空列表。
        //   错误必须可见（诊断面），否则空列表被误读成"预设没条目"。
        if (d?.error) {
          console.warn("[layout] loadEntries:", d.error);
          window._reportError?.(`[preset] ${d.error}`);
        }
        entries = d.entries || [];
        if (!Array.isArray(entries)) entries = [];
        // 多选集与最新条目对齐：删除/重载后剔除已不存在的 key，防「已选 N」虚数
        const liveKeys = new Set(entries.map((x, i) => x.identifier || x.name || `entry_${i}`));
        multiSelIds = new Set([...multiSelIds].filter(k => liveKeys.has(k)));
        renderEntryList();
      } catch (e) {
        console.error("[layout] loadEntries error:", e);
        window._reportError?.(`[layout] loadEntries error: ${e.message}`);
        entries = []; renderEntryList();
      }
    };

    const renderEntryList = () => {
      const list = container.querySelector('#pp-entry-list');
      const search = (container.querySelector('#pp-search')?.value || '').toLowerCase();
      const stats = { total: entries.length, enabled: 0, sys: 0, inj: 0 };

      list.innerHTML = '';
      entries.forEach((e, idx) => {
        const id = e.identifier || e.name || `entry_${idx}`;
        const name = e.name || MARKER_NAMES[id] || id;
        const isMarker = MARKERS.includes(id);
        const enabled = e.enabled !== false;
        if (enabled) stats.enabled++;
        if (e.system_prompt) stats.sys++;
        if (e.injection_position) stats.inj++;

        if (search && !name.toLowerCase().includes(search) && !id.toLowerCase().includes(search)) return;

        const roleBadge = e.role === 'user' ? 'U' : e.role === 'assistant' ? 'A' : 'S';
        const roleColor = e.role === 'user' ? 'badge-info' : e.role === 'assistant' ? 'badge-success' : 'badge-ghost';
        let typeLabel = isMarker ? '<i data-ic="marker"></i>' : e.injection_position ? `D${e.depth||0}` : '系统';
        let typeClass = isMarker ? 'opacity-40' : e.injection_position ? 'text-warning' : 'text-info';

        const item = document.createElement('div');
        // 多选高亮（info 蓝）优先于单选高亮（warning 黄）：同一条同时命中时只显示多选态
        const selCls = multiSelIds.has(id) ? 'bg-info/15 border border-info/40' : (id===selectedId ? 'bg-warning/15 border border-warning/30' : '');
        item.className = `flex items-center gap-1 px-2 py-1 rounded text-xs cursor-pointer hover:bg-base-200/50 ${selCls} ${enabled?'':'opacity-40'}`;
        item.dataset.id = id;
        item.dataset.idx = idx;
        item.draggable = true;
        item.innerHTML = `
          <span class="cursor-grab opacity-30 hover:opacity-100" style="user-select:none">⠿</span>
          <span class="badge badge-xs ${roleColor}">${roleBadge}</span>
          <span class="flex-1 truncate" title="${_escHtml(name)}">${_escHtml(name)}</span>
          <span class="${typeClass} text-[10px]">${typeLabel}</span>
        `;
        // Click to select — Ctrl/⌘+点击=切换多选（不开详情），普通点击=清多选+单选开详情
        item.addEventListener('click', (ev) => {
          if (ev.ctrlKey || ev.metaKey) {
            if (multiSelIds.has(id)) multiSelIds.delete(id); else multiSelIds.add(id);
            renderEntryList();
            return;
          }
          if (multiSelIds.size) multiSelIds.clear();
          selectedId = id; renderEntryList(); renderDetail(e, idx);
        });
        // Drag events — Marker 禁止删除但必须可移动（位置决定提示词组装顺序）。
        // 组拖拽：拖多选成员时整组随动（按列表当前相对顺序），拖非成员=只拖该条。
        item.addEventListener('dragstart', (ev) => {
          draggedIds = (multiSelIds.has(id) && multiSelIds.size > 1)
            ? entries.map((x, i) => x.identifier || x.name || `entry_${i}`).filter(k => multiSelIds.has(k))
            : [id];
          list.querySelectorAll('[data-id]').forEach(el => { if (draggedIds.includes(el.dataset.id)) el.classList.add('opacity-30'); });
          ev.dataTransfer.effectAllowed = 'move';
        });
        item.addEventListener('dragend', () => { draggedIds = []; list.querySelectorAll('[data-id]').forEach(el => el.classList.remove('opacity-30')); list.querySelectorAll('.drag-over-top,.drag-over-bottom').forEach(el => { el.classList.remove('drag-over-top','drag-over-bottom'); }); });
        item.addEventListener('dragover', (ev) => { ev.preventDefault(); if (draggedIds.includes(id)) return; const rect = item.getBoundingClientRect(); const mid = rect.top + rect.height/2; item.classList.toggle('drag-over-top', ev.clientY < mid); item.classList.toggle('drag-over-bottom', ev.clientY >= mid); });
        item.addEventListener('dragleave', () => { item.classList.remove('drag-over-top','drag-over-bottom'); });
        item.addEventListener('drop', async (ev) => {
          ev.preventDefault();
          item.classList.remove('drag-over-top','drag-over-bottom');
          if (!draggedIds.length || draggedIds.includes(id)) return;
          try {
            // 整组重排：抽出拖拽组（保持相对顺序）→ 在剩余序列中定位落点 → 整组插入 → 全量 order 提交
            const dragSet = new Set(draggedIds);
            const keyed = entries.map((x, i) => ({ x, k: x.identifier || x.name || `entry_${i}` }));
            const moving = keyed.filter(p => dragSet.has(p.k)).map(p => p.x);
            const rest = keyed.filter(p => !dragSet.has(p.k));
            let at = rest.findIndex(p => p.k === id);
            if (!moving.length || at < 0) return;
            const rect = item.getBoundingClientRect();
            if (ev.clientY >= rect.top + rect.height/2) at += 1;
            const next = rest.map(p => p.x);
            next.splice(at, 0, ...moving);
            entries = next;
            renderEntryList();
            const order = entries.map(x => x.identifier || x.name);
            await postApi({ _target_preset: currentPresetName, reorder_entries: { order } });
          } catch (e) {
            console.error("[layout] preset drag reorder error:", e);
            window._reportError?.(`[layout] preset drag reorder error: ${e.message}`);
          }
        });
        list.appendChild(item);
      });
      container.querySelector('#pp-stats').textContent = `共 ${stats.total} | 启用 ${stats.enabled} | 系统 ${stats.sys} | 注入 ${stats.inj}` + (multiSelIds.size ? ` | 已选 ${multiSelIds.size}（拖任一选中条=整组移动）` : '');
    };

    const renderDetail = (e, idx) => {
      const detail = container.querySelector('#pp-entry-detail');
      const id = e.identifier || e.name || `entry_${idx}`;
      const isMarker = MARKERS.includes(id);
      const isInjection = !!e.injection_position;

      // Marker = 内容运行时从对应模块提取（ST 同款语义，凛倾0711）：内容不可编辑；
      // 名称/启用/角色可改可存；类型/深度锁定（引擎按 marker 顺序切分组装，不消费其注入位）
      const markerSource = id === 'chatHistory'
        ? '聊天记录切分点：标记预设条目在聊天记录前/后的分界，本身不产生内容。'
        : `此提示词的内容运行时从「${MARKER_NAMES[id] || id}」模块提取，无法在此处编辑。`;
      detail.innerHTML = `
        <div class="space-y-2 text-xs">
          <div class="flex items-center justify-between">
            <span class="font-bold">${isMarker ? '<i data-ic="marker"></i> 位置标记' : '<i data-ic="edit"></i> 条目编辑'}</span>
            ${!isMarker ? `<button id="pp-del-entry" class="btn btn-xs btn-error btn-ghost"><i data-ic="trash"></i></button>` : ''}
          </div>
          <div class="flex items-center gap-2">
            <label class="opacity-60 w-12">名称</label>
            <input id="pp-d-name" class="input input-xs input-bordered flex-1" value="${_escHtml(e.name||MARKER_NAMES[id]||id)}" />
          </div>
          <div class="flex items-center gap-2">
            <label class="opacity-60 w-12">启用</label>
            <input type="checkbox" id="pp-d-enabled" class="toggle toggle-xs toggle-warning" ${e.enabled!==false?'checked':''} />
          </div>
          <div class="flex items-center gap-2">
            <label class="opacity-60 w-12">角色</label>
            <select id="pp-d-role" class="select select-xs select-bordered flex-1">
              <option value="system" ${e.role==='system'||!e.role?'selected':''}>system</option>
              <option value="user" ${e.role==='user'?'selected':''}>user</option>
              <option value="assistant" ${e.role==='assistant'?'selected':''}>assistant</option>
            </select>
          </div>
          <div class="flex items-center gap-2">
            <label class="opacity-60 w-12">类型</label>
            <select id="pp-d-type" class="select select-xs select-bordered flex-1" ${isMarker?'disabled title="位置标记按列表顺序参与组装，类型不可改"':''}>
              <option value="system_prompt" ${!isInjection?'selected':''}>系统提示词</option>
              <option value="injection" ${isInjection?'selected':''}>注入 (Injection)</option>
            </select>
          </div>
          <div id="pp-d-depth-row" class="flex items-center gap-2 ${isInjection?'':'hidden'}">
            <label class="opacity-60 w-12">深度</label>
            <input type="number" id="pp-d-depth" class="input input-xs input-bordered w-20" min="0" max="999" value="${e.depth||0}" ${isMarker?'disabled':''} />
          </div>
          ${isMarker ? `
          <div>
            <label class="opacity-60">内容</label>
            <div class="mt-1 p-2 rounded border border-base-300/40 bg-base-200/30 text-[10px] opacity-60">${_escHtml(markerSource)}</div>
            <label class="opacity-60 mt-2 block">实际注入内容 <span class="opacity-40">（按当前激活预设实时组装）</span></label>
            <div id="pp-d-inspect" class="mt-1 space-y-1"><p class="text-center opacity-50 p-2 text-xs">组装中...</p></div>
          </div>` : `
          <div>
            <label class="opacity-60">内容</label>
            <div class="expandable-container relative mt-1">
              <textarea id="pp-d-content" class="textarea textarea-bordered w-full text-xs font-mono" style="min-height:120px;" data-expandable data-expand-title="${_escHtml(e.name||e.identifier||'')}">${_escHtml(e.content||e.content_preview||'')}</textarea>
              <button class="expand-btn absolute top-1 right-1 btn btn-xs btn-square btn-ghost opacity-50 hover:opacity-100" title="放大编辑">
                <svg xmlns="http://www.w3.org/2000/svg" class="w-3.5 h-3.5" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 8V4h4M17 8V4h-4M3 12v4h4M17 12v4h-4"/></svg>
              </button>
            </div>
            <details id="pp-d-inspect-wrap" class="mt-1">
              <summary class="cursor-pointer opacity-60 text-xs">🔍 实际注入（宏替换后，按当前激活预设组装）</summary>
              <div id="pp-d-inspect" class="mt-1 space-y-1"></div>
            </details>
          </div>`}
          <button id="pp-d-save" class="btn btn-xs btn-primary w-full">💾 保存条目</button>
        </div>
      `;

      // Type switch → show/hide depth
      detail.querySelector('#pp-d-type')?.addEventListener('change', (ev) => {
        detail.querySelector('#pp-d-depth-row').classList.toggle('hidden', ev.target.value !== 'injection');
      });

      // Save entry — marker 只存 name/role（内容与类型引擎不消费其修改）；
      // enabled 走 toggle_entry：引擎真值在 prompt_order（userOrder/systemOrder），
      // updateEntryProps 只写 entry.enabled 不同步 order = 双键不同步，禁把 enabled 塞进 props
      detail.querySelector('#pp-d-save')?.addEventListener('click', async () => {
        const enabled = detail.querySelector('#pp-d-enabled').checked;
        const props = {
          name: detail.querySelector('#pp-d-name').value.trim(), // 0714 trim 扫尾：条目名落盘去首尾空白（名称类字段统一口径）
          role: detail.querySelector('#pp-d-role').value,
        };
        const updatePayload = { identifier: id, props };
        if (!isMarker) {
          const isInj = detail.querySelector('#pp-d-type').value === 'injection';
          updatePayload.content = detail.querySelector('#pp-d-content').value;
          props.system_prompt = !isInj;
          props.injection_position = isInj ? 1 : 0;
          props.injection_depth = isInj ? parseInt(detail.querySelector('#pp-d-depth').value) || 0 : 0;
        }
        try {
          await postApi({ _target_preset: currentPresetName, toggle_entry: { identifier: id, enabled } });
          await postApi({ _target_preset: currentPresetName, update_entry: updatePayload });
          detail.querySelector('#pp-d-save').textContent = '✅ 已保存';
          setTimeout(() => { if(detail.querySelector('#pp-d-save')) detail.querySelector('#pp-d-save').textContent = '💾 保存条目'; }, 1500);
          await loadEntries();
        } catch (err) { showToast("error", '保存失败: ' + err.message); }
      });

      // Delete entry
      detail.querySelector('#pp-del-entry')?.addEventListener('click', async () => {
        if (!await beiluConfirm(`删除条目「${e.name||id}」？`)) return;
        try {
          await postApi({ _target_preset: currentPresetName, delete_entry: { identifier: id } });
          selectedId = null;
          detail.innerHTML = '<p class="text-xs opacity-50 mt-8 text-center">未选择条目。点击左侧条目查看详情</p>';
          await loadEntries();
        } catch (err) {
          console.error("[layout] preset entry delete error:", err);
          window._reportError?.(`[layout] preset entry delete error: ${err.message}`);
          showToast("error", '删除失败: ' + err.message);
        }
      });

      // Inspect 装配：marker 选中即加载（原静态占位=看不到实际内容的 bug 根位）；
      // 普通条目 <details> 首开懒加载（编辑框已显示原文，宏替换后差异才需请求）
      if (isMarker) {
        _loadInspectInto(detail, id);
      } else {
        detail.querySelector('#pp-d-inspect-wrap')?.addEventListener('toggle', (ev) => {
          if (ev.target.open && !ev.target.dataset.loaded) { ev.target.dataset.loaded = '1'; _loadInspectInto(detail, id); }
        });
      }
    };

    // 条目 Inspect（ST PromptManager handleInspect 同构：点条目看它在实际组装中展开的消息）。
    // 数据链：getFakeSend → requestBuilder.buildFakeSendRequest 司令员五段（beilu-preset buildAllEntries
    //   把 marker 从 env[macro] 展开为带 identifier/is_marker 的消息）→ messages 携 _identifier/_section/_tokens 全文。
    // chatHistory 是纯切分点不产内容（preset_engine buildAllEntries chatHistory 分支），其关联消息=
    //   _section==='chatHistory' 的聊天记录段（ST chatHistory-N 同义）；其余条目按 _identifier 精确匹配。
    const _loadInspectInto = async (detail, id) => {
      const box = detail.querySelector('#pp-d-inspect');
      if (!box) return;
      const _msg = (t) => { box.innerHTML = `<p class="text-center opacity-50 p-2 text-xs">${_escHtml(t)}</p>`; };
      // 对话锚点校验：面板打开后对话被切换（hash 后退等），activePreset 判断即失效，先于激活判断拦截
      if ((window._beiluGetChatId?.() || "") !== panelChatId) { _msg('对话已切换，预设面板状态已过期。关闭后重新打开编辑面板再查看。'); return; }
      // fake-send 永远按「当前激活预设」组装；浏览非激活预设时显示的会是别的预设的内容=语义错，诚实拒绝
      if (currentPresetName !== activePreset) { _msg(`此预设未激活。实际组装按激活预设「${(activePreset||'').replace(/\.json$/i,'')}」进行，激活(🎯)后可在此查看。`); return; }
      if (!currentChatId) { _msg('无活跃聊天，无法组装预览。先打开一个聊天再查看。'); return; }
      try {
        const r = await sendAction({ verb: "getFakeSend", target: "shells:chat", source: "web", scope: { chatId: currentChatId } });
        const msgs = r?.messages || [];
        if (!r?._meta?.commander_mode) { _msg('当前组装非司令员模式（预设未产生五段结构），无条目级映射可显示。'); return; }
        // `${id}_fallback` 兼容：引擎在 marker 未产出时兜底补注（现仅 personaDescription_fallback，
        // preset main.mjs bug2 fallback），identifier 带后缀——精确匹配会漏它导致"明明注入了却显示无内容"
        const related = id === 'chatHistory'
          ? msgs.filter(m => m._section === 'chatHistory')
          : msgs.filter(m => m._identifier === id || m._identifier === `${id}_fallback`);
        if (!related.length) { _msg('本次组装中该条目无内容（对应模块为空、条目被禁用或替换后为空）。'); return; }
        box.innerHTML = '';
        let sumTok = 0, sumChars = 0;
        related.forEach((m, i) => {
          const content = m.content || '';
          const chars = content.length;
          const tok = m._tokens ?? Math.round(chars / 3.5);
          sumTok += tok; sumChars += chars;
          const roleColor = m.role === 'user' ? 'badge-info' : m.role === 'assistant' ? 'badge-success' : 'badge-ghost';
          const row = document.createElement('div');
          row.className = 'border border-base-300/40 rounded bg-base-200/20';
          row.innerHTML = `
            <div class="ins-head flex items-center gap-2 px-2 py-1 cursor-pointer hover:bg-base-200/50 text-xs">
              <span class="opacity-40">#${i + 1}</span>
              <span class="badge badge-xs ${roleColor}">${_escHtml(m.role || 'system')}</span>
              <span class="flex-1 truncate opacity-70">${_escHtml(content.slice(0, 60).replace(/\n/g, ' '))}</span>
              <span class="opacity-50 whitespace-nowrap">${tok.toLocaleString()} tok</span>
              <span class="ins-chev opacity-50">▶</span>
            </div>
            <pre class="ins-body hidden px-2 py-1 whitespace-pre-wrap break-all text-[11px] max-h-72 overflow-auto border-t border-base-300/30 font-mono">${_escHtml(content)}</pre>`;
          row.querySelector('.ins-head').addEventListener('click', () => {
            const body = row.querySelector('.ins-body');
            body.classList.toggle('hidden');
            row.querySelector('.ins-chev').textContent = body.classList.contains('hidden') ? '▶' : '▼';
          });
          box.appendChild(row);
        });
        const sum = document.createElement('div');
        sum.className = 'text-[10px] opacity-40 px-1';
        sum.textContent = `共 ${related.length} 条 · ${sumTok.toLocaleString()} tokens · ${sumChars.toLocaleString()} 字符`;
        box.appendChild(sum);
      } catch (err) {
        console.error('[layout] preset inspect error:', err);
        window._reportError?.(`[layout] preset inspect error: ${err.message}`);
        _msg('组装预览失败: ' + err.message);
      }
    };

    // 刷新所有分类tab的badge计数
    const _refreshCatBadges = () => {
      container.querySelectorAll('.pp-filter-tab').forEach(tab => {
        const f = tab.dataset.filter;
        const badge = tab.querySelector('.badge');
        if (!badge) return;
        if (f === 'all') badge.textContent = presets.length;
        else badge.textContent = presets.filter(n => classifyPreset(n) === f).length;
      });
      container.querySelectorAll('#pp-preset-sel option').forEach(opt => { opt.dataset.category = classifyPreset(opt.value); });
    };

    // 应用当前筛选到预设select
    const _applyFilter = () => {
      const sel = container.querySelector('#pp-preset-sel');
      [...sel.options].forEach(opt => {
        const cat = opt.dataset.category || 'chat';
        opt.hidden = currentFilter !== 'all' && cat !== currentFilter;
      });
      if (sel.selectedOptions[0]?.hidden) {
        const firstVisible = [...sel.options].find(o => !o.hidden);
        if (firstVisible) { sel.value = firstVisible.value; sel.dispatchEvent(new Event('change')); }
      }
    };

    // 分类Tab筛选（含自定义分类）
    container.querySelectorAll('.pp-filter-tab').forEach(tab => {
      tab.addEventListener('click', (ev) => {
        // 如果点的是删除按钮，不触发tab切换
        if (ev.target.closest('.pp-cat-del')) return;
        container.querySelectorAll('.pp-filter-tab').forEach(t => t.classList.remove('tab-active'));
        tab.classList.add('tab-active');
        currentFilter = tab.dataset.filter;
        _applyFilter();
      });
    });

    // 自定义分类删除按钮
    container.querySelectorAll('.pp-cat-del').forEach(btn => {
      btn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const catName = btn.dataset.cat;
        if (!await beiluConfirm(`删除自定义分类「${catName}」？\n已归类到此分类的预设将回到自动分类。`)) return;
        // 从分类列表中移除
        const list = _loadCatList();
        const idx = list.indexOf(catName);
        if (idx >= 0) list.splice(idx, 1);
        _saveCatList(list);
        // 清除该分类下的预设映射
        const cats = _loadCategories();
        for (const key of Object.keys(cats)) { if (cats[key] === catName) delete cats[key]; }
        _saveCategories(cats);
        // 重载面板
        _loadPresetPanel();
      });
    });

    // "+"按钮: 添加自定义分类
    container.querySelector('.pp-add-cat-btn')?.addEventListener('click', async () => {
      const name = await beiluPrompt('新分类名称：');
      if (!name?.trim()) return;
      const trimmed = name.trim();
      // 检查重复（内置+自定义）
      if (BUILTIN_CATS.includes(trimmed) || trimmed === 'all') { showToast('error', '该分类名与内置分类冲突'); return; }
      const list = _loadCatList();
      if (list.includes(trimmed)) { showToast('error', '该分类已存在'); return; }
      list.push(trimmed);
      _saveCatList(list);
      _loadPresetPanel(); // 重载面板以显示新tab
    });

    // 右键菜单: 在预设select上右键可快速归类
    container.querySelector('#pp-preset-sel')?.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      const allCats = [...BUILTIN_CATS, ..._loadCatList()];
      // 移除已有的右键菜单
      document.querySelector('.pp-ctx-menu')?.remove();
      const menu = document.createElement('div');
      menu.className = 'pp-ctx-menu fixed bg-base-100 border border-base-300 rounded-lg shadow-xl p-1 min-w-[120px]';
      menu.style.zIndex = 'var(--z-popup)'; // [合并批 0714] 原 z-[9999] 硬编码违层级中央表（index.css 单一权威），接 --z-popup（与 conv-ctx-menu 同层）
      // [0716 二级路径] 菜单末尾加"➕ 自定义二级路径…"入口：prompt 输入 "一级/二级"，
      //   写入 BEILU_PRESET_CATEGORIES 供 classifyPresetRaw 消费。二级组名完全自由，代码零枚举。
      menu.innerHTML = `<div class="text-[10px] opacity-40 px-2 py-1">归类「${_escHtml(currentPresetName.replace(/\.json$/i,''))}」到：</div>`
        + `<button class="pp-ctx-item block w-full text-left text-xs px-2 py-1 rounded hover:bg-base-200 cursor-pointer" data-cat="">自动（清除手动归类）</button>`
        + allCats.map(c => `<button class="pp-ctx-item block w-full text-left text-xs px-2 py-1 rounded hover:bg-base-200 cursor-pointer" data-cat="${_escHtml(c)}">${_escHtml(c === 'chat' ? '聊天' : c === 'code' ? '编程' : c === 'work' ? '工作' : c)}</button>`).join('')
        + `<div class="text-[10px] opacity-40 px-2 py-1 border-t border-base-300 mt-1">高级</div>`
        + `<button class="pp-ctx-item pp-ctx-sub block w-full text-left text-xs px-2 py-1 rounded hover:bg-base-200 cursor-pointer">➕ 自定义二级路径…</button>`;
      document.body.appendChild(menu);
      positionContextMenu(menu, ev.clientX, ev.clientY);
      // 点击菜单项
      menu.querySelectorAll('.pp-ctx-item:not(.pp-ctx-sub)').forEach(item => {
        item.addEventListener('click', () => {
          const cats = _loadCategories();
          const catVal = item.dataset.cat;
          if (catVal) cats[currentPresetName] = catVal;
          else delete cats[currentPresetName];
          _saveCategories(cats);
          _refreshCatBadges();
          // 同步dropdown
          const catSel = container.querySelector('#pp-category');
          if (catSel) catSel.value = cats[currentPresetName] || "";
          // 如果当前有筛选，重新应用
          if (currentFilter !== 'all') _applyFilter();
          menu.remove();
        });
      });
      // [0716 二级路径] 自定义二级路径 prompt 分支：输入 "一级/二级"，一级必须∈内置或自定义分类。
      //   写 BEILU_PRESET_CATEGORIES（用户自定义链，优先级最高，覆盖 registry bucket）。
      //   二级完全自由，代码不校验二级名（值域=任意字符串）。
      menu.querySelector('.pp-ctx-sub')?.addEventListener('click', async () => {
        menu.remove();
        const allCats = [...BUILTIN_CATS, ..._loadCatList()];
        const cur = _loadCategories()[currentPresetName] || '';
        const input = await beiluPrompt(`分类路径「一级/二级」，一级须∈ [${allCats.join(', ')}]，二级任意（如 code/大型项目）：`, cur);
        if (input === null) return;
        const v = String(input).trim();
        if (!v) {
          // 空=清除手动归类（等价"自动"）
          const cats = _loadCategories(); delete cats[currentPresetName]; _saveCategories(cats);
          _refreshCatBadges(); _loadPresetPanel(); return;
        }
        const pri = v.split('/', 2)[0];
        if (!allCats.includes(pri)) { showToast('error', `一级"${pri}"未在分类集内，请先"+ 添加自定义分类"`); return; }
        const cats = _loadCategories(); cats[currentPresetName] = v; _saveCategories(cats);
        _refreshCatBadges(); _loadPresetPanel(); // 重载=下拉/tab 全联动（下拉平铺无 optgroup，0716 删）
      });
      bindClickOutsideClose(menu, () => menu.remove());
    });

    // Search
    container.querySelector('#pp-search').addEventListener('input', () => renderEntryList());

    // Preset management buttons
    container.querySelector('#pp-preset-sel').addEventListener('change', (e) => {
      currentPresetName = e.target.value;
      selectedId = null;
      multiSelIds.clear();
      container.querySelector('#pp-entry-detail').innerHTML = '<p class="text-xs opacity-50 mt-8 text-center">未选择条目。点击左侧条目查看详情</p>';
      loadEntries();
      const catSel = container.querySelector('#pp-category');
      if (catSel) catSel.value = _loadCategories()[currentPresetName] || "";
    });
    container.querySelector('#pp-category')?.addEventListener('change', (e) => {
      const cats = _loadCategories();
      if (e.target.value) cats[currentPresetName] = e.target.value;
      else delete cats[currentPresetName];
      _saveCategories(cats);
      _refreshCatBadges();
      if (currentFilter !== 'all') _applyFilter();
    });
    // [注释校准 2026-07-12] 激活钮现=纯切换（switchPreset 改「正在使用的预设」），不写 bindings。
    //   历史沿革：D1 期曾按"先写 bindings 再应用"设计（当时 getPromptHandler 有 mode_preset_bindings
    //   反向盖回=半死口），反向盖回已随凛倾 07-08 生效模型移除、bindings 写口随之撤销——
    //   绑定是默认初始值，只在浮层四格显式配置。
    container.querySelector('#pp-activate').addEventListener('click', async () => {
      const name = currentPresetName;
      // 生效模型（凛倾 2026-07-08「切换怎么切换?为什么要绑定?」）：激活=直接改「正在使用的预设」
      //   （switchPreset 写 active_preset_map[cid:mode]，mode 后端权威解析），生成时无强切盖回=切了即生效。
      //   原「先写 bindings 再切」已撤——绑定是默认初始值，只在浮层四格显式配置。
      const activateBtn = container.querySelector('#pp-activate');
      try {
        const result = await window._beiluSwitchPreset(name);
        if (result) {
          activePreset = name; // 同步闭包快照：条目 Inspect 判断"浏览中=激活"依赖它，不同步则激活后仍显示"未激活"
          showToast(`已切换预设: "${name}"`, "success");
          if (activateBtn) { activateBtn.textContent = '✅'; setTimeout(() => { if (activateBtn) activateBtn.textContent = '🎯'; }, 1500); }
        } else {
          showToast("预设切换失败", "error");
        }
      } catch (e) {
        console.error('[layout] preset apply error:', e);
        window._reportError?.(`[layout] preset apply error: ${e.message}`);
        showToast("预设切换失败", "error");
      }
    });
    container.querySelector('#pp-new').addEventListener('click', async () => {
      const name = await beiluPrompt('新预设名称：');
      if (!name?.trim()) return;
      try {
        await postApi({ create_preset: { name: name.trim() } });
        _loadPresetPanel();
      } catch (e) { console.error('[layout] preset create error:', e); window._reportError?.(`[layout] preset create error: ${e.message}`); }
    });
    container.querySelector('#pp-dup').addEventListener('click', async () => {
      const newName = await beiluPrompt('复制为：', currentPresetName + '_copy');
      if (!newName?.trim()) return;
      try {
        await postApi({ duplicate_preset: { name: currentPresetName, newName: newName.trim() } });
        _loadPresetPanel();
      } catch (e) { console.error('[layout] preset dup error:', e); window._reportError?.(`[layout] preset dup error: ${e.message}`); }
    });
    container.querySelector('#pp-rename').addEventListener('click', async () => {
      const newName = await beiluPrompt('新名称：', currentPresetName);
      if (!newName?.trim() || newName.trim() === currentPresetName) return;
      try {
        await postApi({ rename_preset: { old_name: currentPresetName, new_name: newName.trim() } });
        _loadPresetPanel();
      } catch (e) { console.error('[layout] preset rename error:', e); window._reportError?.(`[layout] preset rename error: ${e.message}`); }
    });
    // 孤儿verb期4：编辑预设描述（标注适用场景）——镜像 #pp-rename 范式（beiluPrompt 弹窗→postApi→刷新）。
    //   断链根理：后端 update_preset_description（preset/main.mjs update_preset_description case，按 name 找预设改
    //   _meta.description，savePresetFile 单独落盘支持非激活预设）早已存在但前端零入口=孤儿 verb。
    //   回读链：现有描述从 getData 返回体 preset_descriptions[name] 取（GetData 构建 preset_descriptions 映射，:1121-1124/:1140），
    //   作弹窗默认值；改任意预设（含非激活）均生效。路由复用 postApi=updatePresetConfig 桥（字段路由，无需新注册）。
    container.querySelector('#pp-desc').addEventListener('click', async () => {
      const cur = presetData?.preset_descriptions?.[currentPresetName] || "";
      const desc = await beiluPrompt(`预设「${currentPresetName.replace(/\.json$/i,'')}」描述（适用场景）：`, cur);
      if (desc === null) return; // 取消（空串=清空描述，是合法值，故只挡 null）
      try {
        await postApi({ update_preset_description: { name: currentPresetName, description: desc } });
        _loadPresetPanel(); // 刷新 → option title 悬停更新为新描述
      } catch (e) { console.error('[layout] preset desc error:', e); window._reportError?.(`[layout] preset desc error: ${e.message}`); }
    });
    container.querySelector('#pp-del').addEventListener('click', async () => {
      if (!await beiluConfirm(`删除预设「${currentPresetName}」？`)) return;
      try {
        await postApi({ delete_preset: { name: currentPresetName } });
        _loadPresetPanel();
      } catch (e) { console.error('[layout] preset delete error:', e); window._reportError?.(`[layout] preset delete error: ${e.message}`); }
    });
    container.querySelector('#pp-import').addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file'; input.accept = '.json';
      input.addEventListener('change', async () => {
        const file = input.files[0];
        if (!file) return;
        try {
          const text = await file.text();
          const data = JSON.parse(text);
          const presetName = data.name || file.name.replace(/\.json$/i, '');
          // postApi 已返回门面解析体（不再 .json()）
          const importResult = await postApi({ import_preset: { json: data, name: presetName } });
          // 后端重名检测：duplicate=true时弹确认，用户选覆盖则force_overwrite重试
          if (importResult.duplicate) {
            const overwrite = await beiluConfirm(importResult.message || `预设「${presetName}」已存在，是否覆盖？`);
            if (!overwrite) return;
            await postApi({ import_preset: { json: data, name: presetName, force_overwrite: true } });
          }
          // W63: 导入预设时同步regex scripts到beilu-regex
          const regexScripts = data?.extensions?.regex_scripts;
          if (Array.isArray(regexScripts) && regexScripts.length > 0) {
            try {
              // 原 POST regex setdata {_action:syncPresetRegex,...} → 复用分身R beilu-regex 通配路由 verb=真动作组装 _action
              await sendAction({ verb: "syncPresetRegex", target: "plugins:beilu-regex", source: "web", payload: { presetName: presetName, scripts: regexScripts } });
            } catch (e) { console.warn("[preset] regex sync failed:", e); showToast("warning", "预设已导入，但 regex 脚本同步失败: " + (e?.message || e)); } // T021 弹出：部分成功需用户可见
          }
          recordImportHistory("预设", presetName); // T033：上报集中导入历史
          _loadPresetPanel();
        } catch (e) { showToast("error", '导入失败: ' + e.message); }
      });
      input.click();
    });
    container.querySelector('#pp-export').addEventListener('click', async () => {
      try {
        // postApi 已返回门面解析体（不再 .json()）；export_st_preset 是字段分派动作，返回 {success,st_json,name}
        const res = await postApi({ export_st_preset: { name: currentPresetName } });
        if (!res?.success || !res.st_json) { showToast("error", '导出失败: ' + (res?.error || '无 st_json')); return; }
        const blob = new Blob([res.st_json], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = (res.name || currentPresetName).replace(/\.json$/i, '') + '.json';
        a.click();
      } catch (e) { showToast("error", '导出失败: ' + e.message); }
    });
    container.querySelector('#pp-add-entry').addEventListener('click', async () => {
      try {
        const newId = `custom_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
        await postApi({ _target_preset: currentPresetName, add_entry: { identifier: newId, name: "新条目", role: "system", content: "", system_prompt: true, enabled: true } });
        await loadEntries();
      } catch (e) { console.error('[layout] preset add entry error:', e); window._reportError?.(`[layout] preset add entry error: ${e.message}`); }
    });
    container.querySelector('#pp-open-inj')?.addEventListener('click', () => {
      window.dispatchEvent(new CustomEvent("beilu:openEditorTab", { detail: "inj-edit" }));
    });

    // Initial load
    await loadEntries();
  } catch (e) {
    console.error('[layout] loadPresetPanel error:', e);
    window._reportError?.(`[layout] loadPresetPanel error: ${e.message}`);
    container.innerHTML = `<p class="text-sm text-error">预设加载失败: ${e.message}</p>`;
  }
}

// ============================================================
// 注入(INJ)编辑器 — 第4个 tab，与预设编辑同款 UI（左列表+右详情+搜索+增删）。
// 编辑 _global 的 injection_prompts（每轮按 autoMode 注入，非"单次"）。CRUD 走 beilu-memory。
// 原先 INJ 藏在右栏折叠组「单次注入提示词」(名不副实且不在编辑界面)，凛倾要求提到此处可编辑。
// ============================================================

// [0716 快照病灶修·面板普查唯一确诊] INJ 面板刷新接线：统计栏「模式:xxx｜YonBan:已连接」与
//   逐条生效标签（injection_effective 按 activeMode 门控）原只在 load() 一次性拉取=打开后定格
//   （凛倾 0716 截图「模式: code」与顶栏全智能不同步案）。mode-switched/ide-connected/
//   ide-disconnected 三事件均已有 producer 与 8+ 消费面板——本处是纯接线缺口。
//   _injPanelReload 指向最近一次 _loadInjPanel 的 load 闭包（面板每次打开重建 innerHTML，
//   闭包随之更新）；监听器模块级只挂一次防叠加，面板不在 DOM/不可见（offsetParent null）时跳过。
let _injPanelReload = null;
{
  const _injPanelRefresh = () => {
    const c = document.getElementById("airp-inj-container");
    if (!c || !c.offsetParent) return;
    try { _injPanelReload?.(); } catch { /* load 内自带错误渲染 */ }
  };
  // [0716 W4] injectionPromptsChanged：INJ CRUD 广播（本窗回显幂等，跨窗口/别 tab 增删改即时同步）
  for (const _ev of ["beilu:mode-switched", "beilu:ide-connected", "beilu:ide-disconnected", "beilu:injectionPromptsChanged"]) {
    window.addEventListener(_ev, _injPanelRefresh);
  }
}

async function _loadInjPanel() {
  const container = document.getElementById("airp-inj-container");
  if (!container) return;
  container.innerHTML = '<p class="text-xs text-base-content/40">加载中...</p>';
  // 原 raw POST memory setdata（body 带 _action）→ memory 通配路由 verb=真动作组装 _action；返回门面已解析体（调用方不再 .json()）。
  const postSet = (body) => { const { _action, ...rest } = body; return sendAction({ verb: _action, target: "plugins:beilu-memory", source: "web", payload: rest }); };

  let entries = [];
  let selectedId = null;
  let ideConnected = false;
  let backendKind = null; // "cli"|"yonban"|null（0722 识别细化：CLI 连接≠YonBan 连接，互斥只认 YonBan）
  let activeMode = "chat";
  // inj 识别系统 2026-07-13：autoMode 选项与生效判定改为消费后端注入系统单源
  //   （injectionSystem.mjs 经 getData 下发）——原本地 AUTO_MODES 硬编码清单（死值 airp/缺 smart）
  //   与 computeEffective 镜像重算（漏 bot 分支）双双删除，前端只渲染后端真值。
  let autoModeOptions = ["always", "all", "manual"]; // 离线兜底最小集，load() 后被后端权威清单覆盖
  // [0723 双层重构] 模式 chips 数据源=meta.modes/aliases/special（后端单源下发）；filterMode=当前过滤
  //   "__all"=全部，"__special"=全局∗(special 域条目)，其余=具体模式/别名域 id
  let metaModes = [], metaAliases = [], metaSpecial = ["always", "all", "manual", "file"];
  let filterMode = "__all";
  let effectiveById = {};
  const REASON_NOTE = {
    scope_mismatch: "当前模式不匹配",
    platform_mismatch: "平台不匹配",
    unknown_automode: "未知注入模式",
    variant_ide_off: "需 YonBan 连接",
    variant_manual_base: "基础版手动开启",
    base_overridden: "被 -code 变体覆盖",
  };

  const load = async () => {
    // 原 raw GET getdata?_t=（cache no-store）→ 复用 memory#getData 桥路由（POST dispatch，query 缓存参数在桥侧无意义）
    const d = await sendAction({ verb: "getData", target: "plugins:beilu-memory", source: "web" }) || {};
    entries = Array.isArray(d.injection_prompts) ? d.injection_prompts : [];
    ideConnected = !!(d.ide_approvals && d.ide_approvals.ideConnected);
    backendKind = (d.ide_approvals && d.ide_approvals.backendKind) || null;
    activeMode = d.activeMode || "chat";
    if (Array.isArray(d.injection_automode_meta?.options) && d.injection_automode_meta.options.length) {
      autoModeOptions = d.injection_automode_meta.options;
    }
    // [0723 双层重构] 模式 chips 从 meta 派生（modes/aliases/special 三段，缺失时保留兜底值）
    if (Array.isArray(d.injection_automode_meta?.modes)) metaModes = d.injection_automode_meta.modes;
    if (Array.isArray(d.injection_automode_meta?.aliases)) metaAliases = d.injection_automode_meta.aliases;
    if (Array.isArray(d.injection_automode_meta?.special) && d.injection_automode_meta.special.length) metaSpecial = d.injection_automode_meta.special;
    effectiveById = {};
    for (const g of (Array.isArray(d.injection_effective) ? d.injection_effective : [])) {
      effectiveById[g.id] = { on: g.on, note: g.reason ? (REASON_NOTE[g.reason] || g.reason) : "" };
    }
    renderModes(); // [0723] chips 依赖 meta，随每次 load 重渲染（模式集可因注册变化）
    renderList();
  };
  // [0716 快照病灶修] 暴露给模块级事件订阅者（见 _loadInjPanel 前注释），面板重开时指向新闭包
  _injPanelReload = load;

  const renderDetail = (e) => {
    const detail = container.querySelector('#inj-detail');
    if (!e) { detail.innerHTML = '<p class="text-xs opacity-50 mt-8 text-center">未选择条目。点击左侧条目查看详情</p>'; return; }
    detail.innerHTML = `
      <div class="space-y-2 text-xs">
        <div class="flex items-center justify-between">
          <span class="font-bold"><i data-ic="syringe"></i> 注入条目</span>
          <span class="text-[9px] opacity-40 font-mono">${_escHtml(e.id || '')}</span>
        </div>
        <div class="flex items-center gap-2"><label class="opacity-60 w-14">名称</label>
          <input id="inj-d-name" class="input input-xs input-bordered flex-1" value="${_escHtml(e.name || e.description || e.id || '')}" /></div>
        <div class="flex items-center gap-2"><label class="opacity-60 w-14">启用</label>
          <input type="checkbox" id="inj-d-enabled" class="toggle toggle-xs toggle-warning" ${e.enabled !== false ? 'checked' : ''} /></div>
        <div class="flex items-center gap-2"><label class="opacity-60 w-14">角色</label>
          <select id="inj-d-role" class="select select-xs select-bordered flex-1">
            <option value="system" ${(e.role === 'system' || !e.role) ? 'selected' : ''}>system</option>
            <option value="user" ${e.role === 'user' ? 'selected' : ''}>user</option>
            <option value="assistant" ${e.role === 'assistant' ? 'selected' : ''}>assistant</option>
          </select></div>
        <div class="flex items-center gap-2"><label class="opacity-60 w-14">位置</label>
          <select id="inj-d-depth" class="select select-xs select-bordered w-44">
            <option value="1" ${(Number(e.depth) || 0) >= 1 ? 'selected' : ''}>上方（聊天记录之前）</option>
            <option value="0" ${(Number(e.depth) || 0) >= 1 ? '' : 'selected'}>下方（聊天记录之后·尾部）</option>
          </select>
          <span class="text-[9px] opacity-30" title="机制为二区分派（凛倾0722定案：只需上和下）。动态/数据内容放下方=缓存友好">动态内容放下方</span></div>
        <div class="flex items-center gap-2"><label class="opacity-60 w-14">排序</label>
          <input type="number" id="inj-d-order" class="input input-xs input-bordered w-20" value="${e.order ?? 0}" />
          <span class="text-[9px] opacity-30">值越小越靠前（可为负数）</span></div>
        <div class="flex items-center gap-2"><label class="opacity-60 w-14">注入模式</label>
          <select id="inj-d-automode" class="select select-xs select-bordered flex-1">
            ${[...new Set([...autoModeOptions, e.autoMode || 'always'])].map(m => `<option value="${m}" ${(e.autoMode || 'always') === m ? 'selected' : ''}>${m}</option>`).join('')}
          </select></div>
        <div class="flex items-center gap-2"><label class="opacity-60 w-14">平台限定</label>
          <input id="inj-d-platform" class="input input-xs input-bordered flex-1" value="${_escHtml(e.platform || '')}" placeholder="空=不限定；填平台名(discord/telegram…)仅该平台会话注入" /></div>
        <div><label class="opacity-60">内容</label>
          ${e.dataDriven ? '<div class="text-[9px] text-warning/80 my-0.5">⚠ 数据模板条目：内容里的 {{数据宏}} 由系统运行时填充。文本随便改，但删掉宏占位=对应数据不再注入（「恢复默认」可找回出厂模板）</div>' : ''}
          <div class="relative expandable-container">
            <textarea id="inj-d-content" class="textarea textarea-bordered w-full text-xs font-mono" style="min-height:360px;" data-expandable data-expand-title="注入提示词内容">${_escHtml(e.content || '')}</textarea>
            <button class="expand-btn" title="放大编辑">⛶</button>
          </div></div>
        <div class="flex gap-1">
          <button id="inj-d-save" class="btn btn-xs btn-primary flex-1">💾 保存</button>
          <button id="inj-d-del" class="btn btn-xs btn-error btn-ghost"><i data-ic="trash"></i></button>
        </div>
      </div>`;
    detail.querySelector('#inj-d-save').addEventListener('click', async () => {
      const btn = detail.querySelector('#inj-d-save');
      const _name = detail.querySelector('#inj-d-name').value;
      const body = {
        _action: "updateInjectionPrompt", injectionId: e.id,
        enabled: detail.querySelector('#inj-d-enabled').checked,
        name: _name,
        // 不再双写 description=name（原写法每次保存把内置条目的独立 description 抹成 name——双键不同步病）；
        // description 本编辑器无输入框，不传=后端不动它
        role: detail.querySelector('#inj-d-role').value,
        depth: parseInt(detail.querySelector('#inj-d-depth').value) || 0,
        order: parseInt(detail.querySelector('#inj-d-order').value) || 0,
        autoMode: detail.querySelector('#inj-d-automode').value,
        platform: detail.querySelector('#inj-d-platform').value.trim(), // 空串=后端清除限定（update 路径 delete inj.platform）
        content: detail.querySelector('#inj-d-content').value,
      };
      try {
        const j = await postSet(body); // postSet 已返回门面解析体
        await load();
        // 假成功防护：updateInjectionPrompt 找不到 id 时后端可能返 {success:true}，reload 后核实 id 仍在
        if (!j.success || !entries.some(x => x.id === e.id)) { btn.textContent = '⚠ 失败/已失效'; }
        else { btn.textContent = '✅ 已保存'; selectedId = e.id; renderList(); renderDetail(entries.find(x => x.id === e.id)); }
        setTimeout(() => { if (detail.querySelector('#inj-d-save')) detail.querySelector('#inj-d-save').textContent = '💾 保存'; }, 1500);
      } catch (err) { btn.textContent = '❌ ' + err.message; }
    });
    detail.querySelector('#inj-d-del').addEventListener('click', async () => {
      // 删除语义统一（凛倾0722：无论什么都可以删，但加上提示）：不设锁，按条目性质分级提示后果+找回途径
      const _delWarn = e.dataDriven
        ? `「${e.name || e.id}」是数据模板条目，删除后对应功能数据（检索/委派/搜索结果等）将不再注入对话。「恢复默认」可找回。确认删除？`
        : e.builtin
          ? `「${e.name || e.id}」是内置条目，删除后相关功能提示不再注入。「恢复默认」可找回。确认删除？`
          : `删除注入条目「${e.description || e.id}」？`;
      if (!await beiluConfirm(_delWarn)) return;
      try { await postSet({ _action: "deleteInjectionPrompt", injectionId: e.id }); selectedId = null; await load(); renderDetail(null); }
      catch (err) { showToast("error", '删除失败: ' + err.message); }
    });
  };

  // [0723 双层重构] 模式显示名仅为渲染糖（选项集合本身仍来自后端 meta，新模式无映射时回退原 id）
  const MODE_LABEL = { chat: "聊天", airp: "AIRP", code: "代码", work: "工作", smart: "全智能", bot: "Bot", always: "全模式", all: "全模式", manual: "手动开启", file: "文件活动" };
  const _modeLabel = (m) => (MODE_LABEL[m] ? `${MODE_LABEL[m]} ${m}` : m);

  // 模式过滤 chips：全部 → 各模式 → 别名域 → 全局∗（special 域）。选项由 load() 捕获的 meta 派生。
  const renderModes = () => {
    const bar = container.querySelector('#inj-modes');
    if (!bar) return;
    // [0726 凛倾令] 删「全智能 smart」chip：后端 scopes_by_mode.smart = {smart,chat,airp} ⊇ chat 域，
    //   该 chip 与 chat chip 过滤出同一批条目=前端冲突（且当前无条目用 autoMode=smart）。
    //   只删这一个前端 chip——smart 模式本身、autoMode <select> 选项、后端 meta 一律不动。
    const chips = [["__all", "全部"], ...[...new Set([...metaModes, ...metaAliases])].filter((m) => m !== "smart").map((m) => [m, _modeLabel(m)]), ["__special", "全局∗"]];
    bar.innerHTML = chips.map(([v, label]) =>
      `<button data-mode="${_escHtml(v)}" class="btn btn-xs ${filterMode === v ? 'btn-secondary' : 'btn-ghost border border-base-content/15'}" ${v === '__special' ? 'title="always=全模式生效 ｜ all=全模式 ｜ manual=手动开启生效 ｜ file=文件活动模式门控 — 各有门控条件,非无条件全局"' : ''}>${_escHtml(label)}</button>`).join('');
    bar.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { filterMode = b.dataset.mode; renderModes(); renderList(); }));
  };

  // 层归属（纯展示切片，不写盘）：内置/数据模板=系统层，其余=Skill 层（用户自建）
  const _isSystemEntry = (e) => e.builtin === true || e.dataDriven === true;
  // [0723] autoMode 子系列归类：file 是 code 的系统原生子系列（002「file就是code系列，选file归类到code」）。
  //   选 code chip 时，autoMode=code 和 autoMode=file 的条目都归入 code 显示，不再落「全局*」。
  //   _MODE_SUBSERIES：域→该域包含的 autoMode 集合（含自身）；无子系列的域退化为 [自身]。
  const _MODE_SUBSERIES = { code: ["code", "file"] };
  const _passModeFilter = (e) =>
    filterMode === "__all" ? true
    : filterMode === "__special"
      ? metaSpecial.includes(e.autoMode) && !(_MODE_SUBSERIES.code.includes(e.autoMode))
      : (_MODE_SUBSERIES[filterMode] || [filterMode]).includes(e.autoMode);

  const renderList = () => {
    const listSys = container.querySelector('#inj-list-sys');
    const listSkill = container.querySelector('#inj-list-skill');
    const search = (container.querySelector('#inj-search')?.value || '').toLowerCase();
    let enabledN = 0;
    listSys.innerHTML = ''; listSkill.innerHTML = '';
    entries.forEach((e) => {
      if (e.enabled !== false) enabledN++;
      const idStr = e.id || '';
      const name = e.name || e.description || e.id || '';
      if (search && !idStr.toLowerCase().includes(search) && !name.toLowerCase().includes(search)) return;
      if (!_passModeFilter(e)) return;
      const ef = effectiveById[e.id] || { on: false, note: '' };
      let badge;
      if (e.enabled === false) badge = '<span class="text-[9px] opacity-40">已禁用</span>';
      else if (ef.on) badge = '<span class="text-[9px] text-success">✓生效</span>';
      else badge = `<span class="text-[9px] text-warning/70" title="${_escHtml(ef.note || '当前模式不匹配')}">⊘${_escHtml(ef.note || '不匹配')}</span>`;
      const item = document.createElement('div');
      item.className = `flex items-center gap-1 px-2 py-1 rounded text-xs hover:bg-base-200/50 ${e.id === selectedId ? 'bg-warning/15 border border-warning/30' : ''} ${e.enabled !== false ? '' : 'opacity-40'}`;
      item.innerHTML = `
        <input type="checkbox" class="checkbox checkbox-xs checkbox-success inj-row-toggle" ${e.enabled !== false ? 'checked' : ''} title="即时启用/禁用（立即保存）" />
        <span class="badge badge-xs badge-ghost">${String(e.role || 'system')[0].toUpperCase()}</span>
        ${e.dataDriven ? '<span class="badge badge-xs badge-info badge-outline" title="数据模板条目：{{数据宏}}由系统运行时填充">数据</span>' : ''}
        <span class="flex-1 truncate font-mono cursor-pointer inj-row-label" title="${_escHtml(name)}">${_escHtml(idStr)}</span>
        <span class="badge badge-xs badge-ghost opacity-60" title="注入模式(autoMode): ${_escHtml(e.autoMode || 'always')}">${_escHtml(_modeLabel(e.autoMode || 'always'))}</span>
        ${badge}`;
      const cb = item.querySelector('.inj-row-toggle');
      cb.addEventListener('click', (ev) => ev.stopPropagation());
      cb.addEventListener('change', async () => {
        const want = cb.checked;
        try {
          const j = await postSet({ _action: 'updateInjectionPrompt', injectionId: e.id, enabled: want }); // postSet 已返回门面解析体
          if (!j.success) { cb.checked = !want; window._beiluToast?.('保存失败: ' + (j.error || '未知'), 'error'); return; }
          await load();
        } catch (err) { cb.checked = !want; window._beiluToast?.('保存失败: ' + err.message, 'error'); }
      });
      item.querySelector('.inj-row-label').addEventListener('click', () => { selectedId = e.id; renderList(); renderDetail(e); });
      (_isSystemEntry(e) ? listSys : listSkill).appendChild(item);
    });
    if (!listSys.children.length) listSys.innerHTML = '<p class="text-[10px] opacity-30 px-2">（当前过滤下无系统层条目）</p>';
    if (!listSkill.children.length) listSkill.innerHTML = '<p class="text-[10px] opacity-30 px-2">（暂无自建条目——点上方「＋ 新建 Skill」创建）</p>';
    const statsEl = container.querySelector('#inj-stats');
    // 后端标签区分 CLI/YonBan（0722）：CLI 连接时 INJ-2 生效（互斥只认 YonBan），标签与生效判定同源不矛盾
    const _bkLabel = !ideConnected ? '后端: <b class="text-error">未连接</b>'
      : backendKind === 'cli' ? '后端: <b class="text-success">CLI 已连接</b>（INJ-2 域）'
      : '后端: <b class="text-success">YonBan 已连接</b>（INJ-2-code 域）';
    if (statsEl) statsEl.innerHTML = `共 ${entries.length} | 启用 ${enabledN} ｜ ${_bkLabel} ｜ 模式: <b>${_escHtml(activeMode)}</b>`;
  };

  try {
    // [0723 INJ 双层重构·凛倾拍板] 信息架构=层(系统/Skill)×模式(chips) 二维：
    //   系统层=builtin/dataDriven 内置条目（可关/可改，删除分级二次确认，分区头「↺ 恢复默认」=重置）；
    //   Skill 层=用户自建（类似 agent skill），「＋ 新建 Skill」走三步向导（分类窗口→位置→内容）。
    //   分组/过滤为纯前端展示切片：不改存储字段、不动门控（生效真值仍=后端 injection_effective）。
    //   模式 chips 选项来自后端 injection_automode_meta（modes+aliases+special），禁硬编码清单。
    container.innerHTML = `
      <div class="space-y-2">
        <div class="text-[11px] opacity-50"><i data-ic="syringe"></i> 注入提示词（INJ）— 每轮按「注入模式」自动注入对话；全局共享(_global)，各模式/系统都在用。</div>
        <div id="inj-main" class="space-y-2">
        <div id="inj-stats" class="text-[10px] opacity-40"></div>
        <div id="inj-modes" class="flex flex-wrap gap-1"></div>
        <input id="inj-search" class="input input-xs input-bordered w-full" placeholder="搜索 INJ..." />
        <div class="flex gap-2" style="min-height:60vh;">
          <div class="flex flex-col gap-0.5 overflow-y-auto pr-1 shrink-0" style="width:32%;min-width:180px;max-height:70vh;">
            <div class="flex items-center justify-between px-1 py-0.5 rounded bg-base-200/60 sticky top-0 z-10">
              <span class="text-[10px] font-bold opacity-70">🏛 系统层 <span class="font-normal opacity-50">内置·删除需确认</span></span>
              <button id="inj-restore" class="btn btn-xs btn-ghost text-warning" title="重置：从出厂模板恢复全部内置 INJ（重置名称/内容/开关；保留你自建的条目）">↺ 恢复默认</button>
            </div>
            <div id="inj-list-sys" class="flex flex-col gap-0.5"></div>
            <div class="flex items-center justify-between px-1 py-0.5 mt-2 rounded bg-base-200/60 sticky top-0 z-10">
              <span class="text-[10px] font-bold opacity-70">🧩 Skill 层 <span class="font-normal opacity-50">自建·按模式分类</span></span>
              <button id="inj-add" class="btn btn-xs btn-ghost text-success">＋ 新建 Skill</button>
            </div>
            <div id="inj-list-skill" class="flex flex-col gap-0.5"></div>
            <div class="flex items-center justify-between px-1 py-0.5 mt-2 rounded bg-base-200/60 sticky top-0 z-10">
              <span class="text-[10px] font-bold opacity-70">⚡ 单次注入 <span class="font-normal opacity-50">挑条目·仅下一轮</span></span>
              <button id="inj-open-dock" class="btn btn-xs btn-ghost text-info">💉 打开注入坞</button>
            </div>
            <p class="text-[9px] opacity-50 px-1 leading-relaxed">单次注入改为「挑条目」：上面任何一条都能只注入一轮——去对话框工具栏的注入坞，搜到条目点 ⚡ 就跟下一条消息走一次（发完即散、不改开关），点 📌 则长期常驻。不必再另写一份临时文本。</p>
          </div>
          <div id="inj-detail" class="flex-1 overflow-y-auto border-l border-base-content/10 pl-2" style="max-height:70vh;">
            <p class="text-xs opacity-50 mt-8 text-center">未选择条目。点击左侧条目查看详情</p>
          </div>
        </div>
        </div>
      </div>`;
    // 说明书库子 tab 已删（凛倾 0723「说明书库可以删除,和inj重复」：整域删除，skillLibrary.mjs 同批删）
    // [0726 单次注入层重构] 原「面板镜像一个 textarea」已删：单条文本的形态全局只有一份，
    //   写进去下一条必带、无法选择注入哪条、无法存第二条（凛倾「完全没有办法使用…这个完全就是 bug」）。
    //   现在单次注入的对象就是本列表里的条目（注入坞 ⚡ 挑 id 走 INJ 正线），此处只留一个入口，
    //   不做第二份 UI——同一功能两个操作面会立刻长成两个真值源。
    container.querySelector('#inj-open-dock')?.addEventListener('click', () => openInjectDock());
    container.querySelector('#inj-search').addEventListener('input', renderList);
    // [0723 双层重构] 新建 Skill 三步向导（凛倾：「新建先分类分窗口,然后分位置,内容」）。
    //   字段全部既有（addInjectionPrompt 后端 :1446 全字段可接），向导只是呈现方式；
    //   步骤① 分类=选模式窗口（选项按 meta 分组渲染）→ ② 位置(depth/order/role/platform) → ③ 内容。
    container.querySelector('#inj-add').addEventListener('click', () => {
      const w = { autoMode: null, depth: 0, order: 0, role: "system", platform: "", name: "", description: "", content: "" };
      let step = 1;
      const ov = document.createElement('div');
      ov.className = 'modal modal-open';
      document.body.appendChild(ov);
      const close = () => ov.remove();
      const groupBtns = (vals, cls) => vals.map((m) =>
        `<button data-am="${_escHtml(m)}" class="btn btn-xs ${w.autoMode === m ? 'btn-secondary' : cls}">${_escHtml(_modeLabel(m))}</button>`).join('');
      const paint = () => {
        const stepTag = (n, t) => `<span class="flex-1 text-center text-[10px] py-1 rounded ${step === n ? 'bg-secondary text-secondary-content font-bold' : 'bg-base-200 opacity-60'}">${t}</span>`;
        let body = '';
        if (step === 1) {
          // 分组渲染=meta 三段（模式域/别名域/全局与手动），集合本身来自后端，禁硬编码
          body = `
            <p class="text-[10px] opacity-60 mb-1">该 Skill 在哪个模式窗口生效？</p>
            <div class="mb-1 text-[9px] opacity-40">模式窗口</div>
            <div class="flex flex-wrap gap-1">${groupBtns([...new Set([...metaModes, ...metaAliases])], 'btn-ghost border border-base-content/15')}</div>
            <div class="mt-2 mb-1 text-[9px] opacity-40">全局 / 手动（不按模式门控）</div>
            <div class="flex flex-wrap gap-1">${groupBtns(metaSpecial, 'btn-ghost border border-base-content/15')}</div>`;
        } else if (step === 2) {
          body = `
            <div class="flex items-center gap-2 my-1"><label class="opacity-60 w-16 text-[11px]">位置</label>
              <select id="wz-depth" class="select select-xs select-bordered flex-1">
                <option value="0" ${w.depth === 0 ? 'selected' : ''}>下方（聊天记录之后·尾部）</option>
                <option value="1" ${w.depth >= 1 ? 'selected' : ''}>上方（聊天记录之前）</option>
              </select></div>
            <div class="flex items-center gap-2 my-1"><label class="opacity-60 w-16 text-[11px]">排序</label>
              <input id="wz-order" type="number" class="input input-xs input-bordered w-24" value="${w.order}" /><span class="text-[9px] opacity-40">值越小越靠前（可负）</span></div>
            <div class="flex items-center gap-2 my-1"><label class="opacity-60 w-16 text-[11px]">角色</label>
              <select id="wz-role" class="select select-xs select-bordered flex-1">
                ${['system', 'user', 'assistant'].map((r) => `<option ${w.role === r ? 'selected' : ''}>${r}</option>`).join('')}
              </select></div>
            <div class="flex items-center gap-2 my-1"><label class="opacity-60 w-16 text-[11px]">平台限定</label>
              <input id="wz-platform" class="input input-xs input-bordered flex-1" value="${_escHtml(w.platform)}" placeholder="空=不限定（discord/telegram…）" /></div>`;
        } else {
          body = `
            <div class="flex items-center gap-2 my-1"><label class="opacity-60 w-16 text-[11px]">名称</label>
              <input id="wz-name" class="input input-xs input-bordered flex-1" value="${_escHtml(w.name)}" placeholder="如：前端联调守则" /></div>
            <div class="flex items-center gap-2 my-1"><label class="opacity-60 w-16 text-[11px]">说明</label>
              <input id="wz-desc" class="input input-xs input-bordered flex-1" value="${_escHtml(w.description)}" placeholder="可选" /></div>
            <div class="my-1"><label class="opacity-60 text-[11px]">内容</label>
              <textarea id="wz-content" class="textarea textarea-bordered w-full text-xs font-mono" rows="7" placeholder="提示词正文">${_escHtml(w.content)}</textarea></div>`;
        }
        ov.innerHTML = `
          <div class="modal-box max-w-lg">
            <h3 class="text-sm font-bold">＋ 新建 Skill 注入</h3>
            <div class="flex gap-1 my-2">${stepTag(1, '① 分类（窗口）')}${stepTag(2, '② 位置')}${stepTag(3, '③ 内容')}</div>
            <div style="min-height:160px">${body}</div>
            <div class="modal-action flex justify-between">
              <button id="wz-prev" class="btn btn-xs" ${step === 1 ? 'disabled' : ''}>‹ 上一步</button>
              <span class="flex gap-2">
                <button id="wz-cancel" class="btn btn-xs btn-ghost">取消</button>
                <button id="wz-next" class="btn btn-xs btn-secondary">${step === 3 ? '✔ 创建' : '下一步 ›'}</button>
              </span>
            </div>
          </div>`;
        ov.querySelectorAll('[data-am]').forEach((b) => b.addEventListener('click', () => { w.autoMode = b.dataset.am; paint(); }));
        const grab = () => { // 离开当前步前收字段（含直接点上一步的场景）
          if (step === 2) {
            w.depth = parseInt(ov.querySelector('#wz-depth')?.value) || 0;
            w.order = parseInt(ov.querySelector('#wz-order')?.value) || 0;
            w.role = ov.querySelector('#wz-role')?.value || 'system';
            w.platform = (ov.querySelector('#wz-platform')?.value || '').trim();
          } else if (step === 3) {
            w.name = (ov.querySelector('#wz-name')?.value || '').trim();
            w.description = (ov.querySelector('#wz-desc')?.value || '').trim();
            w.content = ov.querySelector('#wz-content')?.value || '';
          }
        };
        ov.querySelector('#wz-cancel').addEventListener('click', close);
        ov.querySelector('#wz-prev').addEventListener('click', () => { grab(); if (step > 1) { step--; paint(); } });
        ov.querySelector('#wz-next').addEventListener('click', async () => {
          grab();
          if (step === 1) { if (!w.autoMode) { window._beiluToast?.('先选择一个分类（模式窗口）', 'warning'); return; } step = 2; paint(); return; }
          if (step === 2) { step = 3; paint(); return; }
          if (!w.name) { window._beiluToast?.('名称不能为空', 'warning'); return; }
          const btn = ov.querySelector('#wz-next'); btn.disabled = true; btn.textContent = '创建中…';
          try {
            const j = await postSet({
              _action: "addInjectionPrompt", name: w.name, description: w.description, enabled: true,
              role: w.role, depth: w.depth, order: w.order, autoMode: w.autoMode, content: w.content,
              ...(w.platform ? { platform: w.platform } : {}),
            });
            if (!j.success) { btn.disabled = false; btn.textContent = '✔ 创建'; window._beiluToast?.('新增失败: ' + (j.error || '未知'), 'error'); return; }
            close(); selectedId = j.id || null; await load();
            if (selectedId) renderDetail(entries.find((x) => x.id === selectedId) || null);
          } catch (err) { btn.disabled = false; btn.textContent = '✔ 创建'; window._beiluToast?.('新增失败: ' + err.message, 'error'); }
        });
      };
      paint();
    });
    container.querySelector('#inj-restore').addEventListener('click', async () => {
      if (!await beiluConfirm("恢复默认会把所有内置 INJ 重置为出厂值（名称/内容/开关都会覆盖），你删除过的内置条目会重新出现；你自建的条目保留。确定？")) return;
      const btn = container.querySelector('#inj-restore');
      btn.textContent = '恢复中…'; btn.disabled = true;
      try {
        const j = await postSet({ _action: "restoreDefaultInjections" }); // postSet 已返回门面解析体
        if (!j.success) { btn.textContent = '⚠ ' + (j.error || '失败'); }
        else { selectedId = null; await load(); renderDetail(null); btn.textContent = `✅ 已恢复${j.restored || ''}`; }
      } catch (err) { btn.textContent = '❌ ' + err.message; }
      setTimeout(() => { const b = container.querySelector('#inj-restore'); if (b) { b.textContent = '↺ 恢复默认'; b.disabled = false; } }, 1800);
    });
    await load();
  } catch (e) {
    console.error('[layout] loadInjPanel error:', e);
    window._reportError?.(`[layout] loadInjPanel error: ${e.message}`);
    container.innerHTML = `<p class="text-sm text-error">注入提示词加载失败: ${e.message}</p>`;
  }
}

// ============================================================
// 角色卡编辑弹窗 (从旧版usage.mjs移植)
// ============================================================
async function _openCharEditDialog(charKey, details, onSaved) {
  // 从后端API加载角色实际数据（chardata.json），cachedDetails里没有这些字段
  let chardata = details?.chardata || {};
  try {
    // 原 raw GET char-data/${key} + cdRes.ok 手检 → 复用分身S getCharData（payload.charId 进 URL）；!ok 由门面抛错走 catch（保留 details.chardata）
    chardata = await sendAction({ verb: "getCharData", target: "shells:chat", source: "web", payload: { charId: charKey } });
  } catch (e) { console.error('[layout] char data fetch error:', e); }
  const existingDialog = document.getElementById("char-edit-dialog");
  if (existingDialog) existingDialog.remove();

  function getAvatarUrl() {
    // uncached（details 未加载）走懒加载 image.png；已加载则 C7 统一契约解析（空串/缺失→fallback）
    if (!details) return `/parts/chars:${encodeURIComponent(charKey)}/image.png`;
    return resolveAvatar({ avatar: details.info?.avatar, kind: "chars", name: charKey });
  }

  const dialog = document.createElement("div");
  dialog.id = "char-edit-dialog";
  // 角色卡编辑弹窗是「角色卡选择窗(#char-selector-overlay = var(--z-overlay))」的子弹窗，
  // 从选择窗内 ⚙ 打开时选择窗仍在 DOM，故层级必须高于它（--z-overlay-nested），否则被完全遮住。
  dialog.style.cssText = "position:fixed;inset:0;z-index:var(--z-overlay-nested);background:rgba(0,0,0,0.75);display:flex;align-items:center;justify-content:center;";
  dialog.innerHTML = `
    <div style="width:min(600px,90vw);max-height:85vh;background:oklch(var(--b1));border-radius:12px;overflow-y:auto;padding:24px;position:relative;">
      <button id="char-edit-close" style="position:absolute;top:8px;right:12px;background:none;border:none;font-size:18px;cursor:pointer;opacity:0.5;">✕</button>
      <h3 class="text-lg font-bold mb-4">编辑角色卡 — ${_escHtml(charKey)}</h3>
      <div class="flex gap-4 mb-4">
        <div class="shrink-0">
          <div style="width:80px;height:80px;border-radius:50%;overflow:hidden;background:oklch(var(--b2));display:flex;align-items:center;justify-content:center;font-size:2rem;cursor:pointer;" id="char-edit-avatar-preview">
            <img src="${_escHtml(getAvatarUrl())}" style="width:100%;height:100%;object-fit:cover;" onerror="this.style.display='none';this.parentElement.textContent='🎭'" />
          </div>
          <input type="file" accept="image/*" id="char-edit-avatar-file" style="display:none" />
          <button class="btn btn-xs btn-ghost w-full mt-1" id="char-edit-avatar-btn">换头像</button>
        </div>
        <div class="flex-1 space-y-2">
          <label class="form-control"><span class="text-xs text-base-content/40">角色名</span>
            <input type="text" class="input input-sm input-bordered w-full" id="char-edit-name" value="${_escHtml(chardata.name || charKey)}" /></label>
        </div>
      </div>
      <div class="space-y-3">
        <label class="form-control"><span class="text-xs text-base-content/40">开场白 (first_mes)</span>
          <div class="relative expandable-container"><textarea class="textarea textarea-bordered w-full text-xs" id="char-edit-firstmes" rows="3" data-expandable data-expand-title="开场白 (first_mes)">${_escHtml(chardata.first_mes || "")}</textarea><button class="expand-btn" title="放大编辑">⛶</button></div></label>
        <label class="form-control"><span class="text-xs text-base-content/40">描述 (description)</span>
          <div class="relative expandable-container"><textarea class="textarea textarea-bordered w-full text-xs" id="char-edit-desc" rows="3" data-expandable data-expand-title="描述 (description)">${_escHtml(chardata.description || "")}</textarea><button class="expand-btn" title="放大编辑">⛶</button></div></label>
        <label class="form-control"><span class="text-xs text-base-content/40">性格 (personality)</span>
          <div class="relative expandable-container"><textarea class="textarea textarea-bordered w-full text-xs" id="char-edit-personality" rows="2" data-expandable data-expand-title="性格 (personality)">${_escHtml(chardata.personality || "")}</textarea><button class="expand-btn" title="放大编辑">⛶</button></div></label>
        <label class="form-control"><span class="text-xs text-base-content/40">场景 (scenario)</span>
          <div class="relative expandable-container"><textarea class="textarea textarea-bordered w-full text-xs" id="char-edit-scenario" rows="2" data-expandable data-expand-title="场景 (scenario)">${_escHtml(chardata.scenario || "")}</textarea><button class="expand-btn" title="放大编辑">⛶</button></div></label>
        <label class="form-control"><span class="text-xs text-base-content/40">对话示例 (mes_example)</span>
          <div class="relative expandable-container"><textarea class="textarea textarea-bordered w-full text-xs" id="char-edit-mesexample" rows="3" data-expandable data-expand-title="对话示例 (mes_example)">${_escHtml(chardata.mes_example || "")}</textarea><button class="expand-btn" title="放大编辑">⛶</button></div></label>
        <label class="form-control"><span class="text-xs text-base-content/40">系统提示词 (system_prompt)</span>
          <div class="relative expandable-container"><textarea class="textarea textarea-bordered w-full text-xs" id="char-edit-sysprompt" rows="3" data-expandable data-expand-title="系统提示词 (system_prompt)">${_escHtml(chardata.system_prompt || "")}</textarea><button class="expand-btn" title="放大编辑">⛶</button></div></label>
        <label class="form-control"><span class="text-xs text-base-content/40">历史后指令 (post_history_instructions)</span>
          <div class="relative expandable-container"><textarea class="textarea textarea-bordered w-full text-xs" id="char-edit-posthistory" rows="2" data-expandable data-expand-title="历史后指令 (post_history_instructions)">${_escHtml(chardata.post_history_instructions || "")}</textarea><button class="expand-btn" title="放大编辑">⛶</button></div></label>
        <label class="form-control"><span class="text-xs text-base-content/40">创作者备注 (creator_notes)</span>
          <div class="relative expandable-container"><textarea class="textarea textarea-bordered w-full text-xs" id="char-edit-notes" rows="2" data-expandable data-expand-title="创作者备注 (creator_notes)">${_escHtml(chardata.creator_notes || "")}</textarea><button class="expand-btn" title="放大编辑">⛶</button></div></label>
      </div>
      <div class="flex gap-2 mt-4">
        <button class="btn btn-sm btn-warning flex-1" id="char-edit-save"><i data-ic="save"></i> 保存</button>
        <button class="btn btn-sm btn-error btn-outline" id="char-edit-delete"><i data-ic="trash"></i> 删除</button>
        <button class="btn btn-sm btn-ghost" id="char-edit-cancel">取消</button>
      </div>
      <div id="char-edit-status" class="text-xs text-center mt-2"></div>
    </div>
  `;
  document.body.appendChild(dialog);

  // 头像上传
  dialog.querySelector("#char-edit-avatar-btn")?.addEventListener("click", () => dialog.querySelector("#char-edit-avatar-file")?.click());
  dialog.querySelector("#char-edit-avatar-file")?.addEventListener("change", (ev) => {
    const file = ev.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const preview = dialog.querySelector("#char-edit-avatar-preview");
      if (preview) preview.innerHTML = `<img src="${reader.result}" style="width:100%;height:100%;object-fit:cover;" />`;
    };
    reader.readAsDataURL(file);
  });

  const close = () => dialog.remove();
  dialog.querySelector("#char-edit-close")?.addEventListener("click", close);
  dialog.querySelector("#char-edit-cancel")?.addEventListener("click", close);
  dialog.addEventListener("click", (ev) => { if (ev.target === dialog) close(); });

  // 保存
  dialog.querySelector("#char-edit-save")?.addEventListener("click", async () => {
    const status = dialog.querySelector("#char-edit-status");
    if (status) status.textContent = "保存中...";
    try {
      const formData = new FormData();
      formData.append("name", dialog.querySelector("#char-edit-name")?.value || charKey);
      formData.append("first_mes", dialog.querySelector("#char-edit-firstmes")?.value || "");
      formData.append("description", dialog.querySelector("#char-edit-desc")?.value || "");
      formData.append("personality", dialog.querySelector("#char-edit-personality")?.value || "");
      formData.append("scenario", dialog.querySelector("#char-edit-scenario")?.value || "");
      formData.append("mes_example", dialog.querySelector("#char-edit-mesexample")?.value || "");
      formData.append("system_prompt", dialog.querySelector("#char-edit-sysprompt")?.value || "");
      formData.append("post_history_instructions", dialog.querySelector("#char-edit-posthistory")?.value || "");
      formData.append("creator_notes", dialog.querySelector("#char-edit-notes")?.value || "");
      const avatarFile = dialog.querySelector("#char-edit-avatar-file")?.files?.[0];
      if (avatarFile) formData.append("avatar", avatarFile);
      // 原 raw PUT update-char/${key}（FormData）+ res.ok 手检（读 body.error）→ 门面 updateCharForm（FormData 变体，区别于分身S 的 JSON updateChar；payload.charId 进 URL，formData 直传）；!ok 由门面抛错（apiFetch 已解析 body.error 进消息）走 catch
      await sendAction({ verb: "updateCharForm", target: "shells:chat", source: "web", payload: { charId: charKey, formData } });
      if (status) status.textContent = "✅ 保存成功";
      onSaved?.();
      setTimeout(close, 800);
    } catch (e) {
      if (status) status.textContent = "❌ " + e.message;
    }
  });

  // 删除
  dialog.querySelector("#char-edit-delete")?.addEventListener("click", async () => {
    if (!await beiluConfirm(`确定删除角色「${charKey}」？将同时删除该角色的所有对话（记忆保留）。此操作不可恢复。`)) return;
    try {
      // 角色卡删除后其对话不再有归属，必须一并删除，否则残留对话仍被 getChatList 扫到、
      // 在对话列表里显示已删角色。记忆默认保留（deleteMemory 不传）。
      // 原 raw DELETE delete-char/${key} {deleteChats} → 门面 deleteChar（payload._key 进 URL，deleteChats 进 body）；
      //   门面 200 返回解析体（success:false+failedPaths 分支保留）；HTTP !ok 由门面抛错走 catch（generic toast）。
      const data = await sendAction({ verb: "deleteChar", target: "shells:chat", source: "web", payload: { _key: charKey, deleteChats: true, deleteWorldbook: true, deleteMemory: true } }) || {};
      // 删除未彻底：后端返回 success:false + failedPaths → 失败回报，不清前端状态、不关闭，便于重试
      if (data.success === false) {
        const paths = Array.isArray(data.failedPaths)
          ? data.failedPaths.map(f => (f && f.path) ? f.path : f).join("、")
          : "";
        const reason = data.error || "未知错误";
        window._beiluToast?.(
          `删除失败：${reason}${paths ? `（残留：${paths}）` : ""}。请稍后点击删除重试。`,
          "error",
        );
        return;
      }
      // 清前端当前角色状态：删的若是当前角色，必须清掉运行时+持久身份，
      // 否则 getCurrentCharName 仍返回已删角色名，列表头/过滤仍显示它。
      // [R6 身份收口 0713] 桥=commitCurrentChar：空值即清两态，原并排 remove 直写删除。
      const wasCurrentChar = storage.get(KEYS.BEILU_LAST_CHAR) === charKey;
      if (wasCurrentChar) {
        window._beiluSetCharName?.("");
      }
      // 对称清理收藏列表（写入侧见 char-card-fav 处），否则收藏过的已删角色名残留可见。
      try {
        const favs = JSON.parse(storage.get(KEYS.BEILU_CHAR_FAVORITES) || "[]");
        const next = favs.filter(n => n !== charKey);
        if (next.length !== favs.length) storage.set(KEYS.BEILU_CHAR_FAVORITES, JSON.stringify(next));
      } catch {}
      window._beiluToast?.(`已删除角色「${charKey}」`, "success");
      close();
      if (wasCurrentChar) {
        window.location.hash = "";
        window.location.reload();
        return;
      }
      onSaved?.();
    } catch (e) {
      window._beiluToast?.("删除失败: " + e.message + "。请稍后重试。", "error");
    }
  });
}

// 世界书内联编辑器（从editorTab3_20260624_2104备份恢复，含动态注入配置编辑）
// [0716 W1 刷新机制] 世界书面板刷新接线（INJ 面板 _injPanelReload 同范式）：后端 worldbook_changed
//   广播（saveConfigToDisk 单点 producer）→ ws 桥 beilu:worldbookChanged → 面板可见时整体重载
//   （跨窗口/本窗回显幂等）。监听器模块级只挂一次。
let _wbPanelReloadFn = null;
{
  const _wbPanelRefresh = () => {
    const c = document.getElementById("airp-wb-container");
    if (!c || !c.offsetParent) return;
    try { _wbPanelReloadFn?.(); } catch { /* 面板内自带错误渲染 */ }
  };
  window.addEventListener("beilu:worldbookChanged", _wbPanelRefresh);
}

async function _loadWorldbookInline() {
  const container = document.getElementById("airp-wb-container");
  if (!container) return;
  _wbPanelReloadFn = _loadWorldbookInline; // 整体重载（函数自身可重入：重建 innerHTML+重拉数据）
  // T6b：WB_API_GET/SET 常量随 apiFetch 收口删除——worldbook 出向走 sendAction（getData + 字段写 verb，复用分身S 路由）。
  let worldbooks = [], activeWb = null, entries = [], selectedEntry = null;

  async function loadData() {
    try {
      // 原 raw GET worldbook getdata + res.ok 手检 → 复用 getData；!ok 由门面抛错走 catch（"世界书加载失败"）
      const data = await sendAction({ verb: "getData", target: "plugins:beilu-worldbook", source: "web" });
      worldbooks = data.worldbook_list || [];
      activeWb = data.active_worldbook || worldbooks[0] || null;
      entries = data.entries || [];
    } catch (e) {
      container.innerHTML = `<p class="text-sm text-error">世界书加载失败: ${e.message}</p>`;
    }
  }

  function render() {
    const stats = { total: entries.length, enabled: entries.filter(e => !e.disable).length, constant: entries.filter(e => e.activationMode === "constant").length };
    container.innerHTML = `
      <div class="flex items-center gap-2 mb-3 flex-wrap">
        <select class="select select-xs select-bordered" id="wb-selector">${worldbooks.map(w => `<option value="${_escHtml(w)}" ${w===activeWb?'selected':''}>${_escHtml(w)}</option>`).join("")}</select>
        <button class="btn btn-xs btn-ghost" id="wb-create">+新建</button>
        <!-- 孤儿verb期3·操作动作类：世界书重命名/导出（后端 rename_worldbook:1045 / export_worldbook:979 有 case，前端零入口=孤儿）。
             按钮跟随既有 #wb-create 工具栏结构，禁硬编码（名称取 #wb-selector.value 当前选中世界书，非写死）。-->
        <button class="btn btn-xs btn-ghost" id="wb-rename" title="重命名当前世界书" ${worldbooks.length?'':'disabled'}>✎重命名</button>
        <button class="btn btn-xs btn-ghost" id="wb-export" title="导出当前世界书为 ST lorebook JSON" ${worldbooks.length?'':'disabled'}><i data-ic="upload"></i>导出</button>
        <!-- 使用链审计0706·世界书导入/删除（后端 import_worldbook:975 / delete_worldbook:1006 有 case，旧壳 beilu-home 有入口而新壳零入口=功能未迁移；
             导入导出聚合面板世界书卡跳到本编辑器，此前落地是死路）。按钮跟随 #wb-rename/#wb-export 工具栏结构，名称取 #wb-selector.value 非硬编码。-->
        <button class="btn btn-xs btn-ghost" id="wb-import" title="导入 ST lorebook JSON 为新世界书"><i data-ic="download"></i>导入</button>
        <button class="btn btn-xs btn-ghost" id="wb-delete" title="删除当前世界书" ${worldbooks.length?'':'disabled'}><i data-ic="trash"></i>删除</button>
        <span class="text-[10px] opacity-50 ml-auto">${stats.total}条 | ${stats.enabled}启用 | ${stats.constant}常驻</span>
      </div>
      <div class="flex gap-2" style="height:calc(100% - 48px);min-height:400px;">
        <div class="w-48 shrink-0 overflow-y-auto border-r border-base-content/10 pr-2" id="wb-list">
          <input type="text" class="input input-xs input-bordered w-full mb-2" id="wb-search" placeholder="搜索..." />
          <button class="btn btn-xs btn-outline w-full mb-2" id="wb-add-entry" style="border-color:var(--beilu-amber);color:var(--beilu-amber)">+ 添加条目</button>
          <div id="wb-entry-list"></div>
        </div>
        <div class="flex-1 overflow-y-auto" id="wb-detail">
          <p class="text-sm opacity-40 text-center py-8">未选择条目。从左侧选择后在此处编辑</p>
        </div>
      </div>`;
    renderEntryList();
    bindEvents();
  }

  function renderEntryList(filter) {
    const listEl = container.querySelector("#wb-entry-list");
    if (!listEl) return;
    const filtered = filter ? entries.filter(e => (e.comment||"").toLowerCase().includes(filter.toLowerCase()) || (e.key||[]).join(",").toLowerCase().includes(filter.toLowerCase())) : entries;
    listEl.innerHTML = filtered.map((e, i) => {
      const isActive = selectedEntry === i;
      const modeIcon = e.activationMode === "constant" ? '<i data-ic="pin"></i>' : e.activationMode === "dynamic" ? '<i data-ic="chart"></i>' : '<i data-ic="key"></i>';
      return `<div class="flex items-center gap-1 px-2 py-1 rounded text-xs cursor-pointer mb-0.5 ${isActive ? 'font-bold' : 'hover:bg-base-200'} ${e.disable ? 'opacity-30' : ''}" style="${isActive ? 'background:var(--beilu-amber-15)' : ''}" data-wb-idx="${i}">
        <span>${modeIcon}</span><span class="truncate flex-1">${_escHtml(e.comment || `条目${i}`)}</span>
      </div>`;
    }).join("");
    listEl.querySelectorAll("[data-wb-idx]").forEach(el => {
      el.addEventListener("click", () => { selectedEntry = parseInt(el.dataset.wbIdx); renderDetail(); renderEntryList(container.querySelector("#wb-search")?.value); });
    });
  }

  function renderDetail() {
    const detail = container.querySelector("#wb-detail");
    if (!detail || selectedEntry == null || !entries[selectedEntry]) return;
    const e = entries[selectedEntry];
    detail.innerHTML = `
      <div class="space-y-3 p-2">
        <div class="flex items-center gap-2">
          <input type="text" class="input input-sm input-bordered flex-1" id="wb-e-comment" value="${_escHtml(e.comment||"")}" placeholder="条目标题" />
          <label class="flex items-center gap-1"><input type="checkbox" class="toggle toggle-xs toggle-success" id="wb-e-enabled" ${!e.disable?'checked':''} /><span class="text-[10px]">启用</span></label>
        </div>
        <div class="grid grid-cols-3 gap-2">
          <label class="form-control"><span class="text-[10px] opacity-40">激活模式</span>
            <select class="select select-xs select-bordered" id="wb-e-mode">
              <option value="constant" ${e.activationMode==="constant"?"selected":""}>常驻</option>
              <option value="regex" ${e.activationMode==="regex"||!e.activationMode?"selected":""}>关键词</option>
              <option value="dynamic" ${e.activationMode==="dynamic"?"selected":""}>动态</option>
            </select></label>
          <label class="form-control"><span class="text-[10px] opacity-40">位置</span>
            <select class="select select-xs select-bordered" id="wb-e-position">
              <option value="0" ${e.position==0?"selected":""}>角色描述前</option>
              <option value="1" ${e.position==1?"selected":""}>角色描述后</option>
              <option value="4" ${e.position==4?"selected":""}>@depth</option>
            </select></label>
          <label class="form-control"><span class="text-[10px] opacity-40">深度</span>
            <input type="number" class="input input-xs input-bordered" id="wb-e-depth" value="${e.depth??4}" min="0" max="99" /></label>
        </div>
        <div id="wb-keys-section" class="${e.activationMode==='constant'||e.activationMode==='dynamic'?'hidden':''}">
          <label class="form-control"><span class="text-[10px] opacity-40">关键词(逗号分隔)</span>
            <input type="text" class="input input-xs input-bordered w-full" id="wb-e-keys" value="${_escHtml((e.key||[]).join(', '))}" /></label>
          <label class="form-control mt-1"><span class="text-[10px] opacity-40">副关键词(逗号分隔，AND逻辑)</span>
            <input type="text" class="input input-xs input-bordered w-full" id="wb-e-keys2" value="${_escHtml((e.keysecondary||[]).join(', '))}" /></label>
          <label class="flex items-center gap-1 mt-1"><input type="checkbox" class="checkbox checkbox-xs" id="wb-e-useregex" ${e.useRegex?'checked':''} /><span class="text-[10px] opacity-40">关键词用正则匹配</span></label>
        </div>
        <div id="wb-dyn-section" class="space-y-2 ${e.activationMode==='dynamic'?'':'hidden'}">
          <div class="text-[10px] opacity-40">动态激活配置（按记忆表格数据决定是否激活）</div>
          <label class="form-control"><span class="text-[10px] opacity-40">列名（从记忆表格）</span>
            <select class="select select-xs select-bordered w-full" id="wb-e-dyn-col">
              <option value="">选择列...</option>
            </select></label>
          <label class="form-control"><span class="text-[10px] opacity-40">匹配方式</span>
            <select class="select select-xs select-bordered" id="wb-e-dyn-match">
              <option value="range" ${(e.dynamicConfig?.matchType||'range')==='range'?'selected':''}>区间匹配</option>
              <option value="exact" ${e.dynamicConfig?.matchType==='exact'?'selected':''}>精确匹配</option>
            </select></label>
          <div id="wb-dyn-range" class="grid grid-cols-2 gap-2 ${e.dynamicConfig?.matchType==='exact'?'hidden':''}">
            <label class="form-control"><span class="text-[10px] opacity-40">最小值</span>
              <input type="number" class="input input-xs input-bordered" id="wb-e-dyn-min" value="${e.dynamicConfig?.rangeMin??0}" /></label>
            <label class="form-control"><span class="text-[10px] opacity-40">最大值</span>
              <input type="number" class="input input-xs input-bordered" id="wb-e-dyn-max" value="${e.dynamicConfig?.rangeMax??0}" /></label>
          </div>
          <div id="wb-dyn-exact" class="${e.dynamicConfig?.matchType==='exact'?'':'hidden'}">
            <label class="form-control"><span class="text-[10px] opacity-40">精确值</span>
              <input type="text" class="input input-xs input-bordered w-full" id="wb-e-dyn-exact" value="${_escHtml(e.dynamicConfig?.exactValue||'')}" /></label>
          </div>
        </div>
        <div class="grid grid-cols-2 gap-2">
          <label class="form-control"><span class="text-[10px] opacity-40">排序权重</span>
            <input type="number" class="input input-xs input-bordered" id="wb-e-order" placeholder="后端默认" value="${e.order ?? ''}" /></label>
          <label class="form-control"><span class="text-[10px] opacity-40">注入角色</span>
            <select class="select select-xs select-bordered" id="wb-e-role">
              <option value="" ${e.role==null?'selected':''}>默认</option>
              <option value="0" ${e.role===0?'selected':''}>system</option>
              <option value="1" ${e.role===1?'selected':''}>user</option>
              <option value="2" ${e.role===2?'selected':''}>assistant</option>
            </select></label>
        </div>
        <label class="form-control"><span class="text-[10px] opacity-40">内容</span>
          <div class="relative expandable-container">
            <textarea class="textarea textarea-bordered w-full text-xs font-mono" id="wb-e-content" rows="8" data-expandable data-expand-title="世界书条目内容">${_escHtml(e.content||"")}</textarea>
            <button class="expand-btn" data-expand-target="wb-e-content" title="放大编辑">⛶</button>
          </div></label>
        <div class="flex gap-2">
          <button class="btn btn-xs flex-1" id="wb-e-save" style="background:var(--beilu-amber);color:#000"><i data-ic="save"></i> 保存</button>
          <button class="btn btn-xs btn-error btn-outline" id="wb-e-delete"><i data-ic="trash"></i> 删除</button>
        </div>
        <div id="wb-e-status" class="text-xs text-center"></div>
      </div>`;
    detail.querySelector("#wb-e-mode")?.addEventListener("change", function() {
      detail.querySelector("#wb-keys-section")?.classList.toggle("hidden", this.value === "constant" || this.value === "dynamic");
      detail.querySelector("#wb-dyn-section")?.classList.toggle("hidden", this.value !== "dynamic");
    });
    detail.querySelector("#wb-e-dyn-match")?.addEventListener("change", function() {
      detail.querySelector("#wb-dyn-range")?.classList.toggle("hidden", this.value === "exact");
      detail.querySelector("#wb-dyn-exact")?.classList.toggle("hidden", this.value !== "exact");
    });
    // 拉记忆表格列名填充动态激活的columnName下拉
    (async () => {
      try {
        const colSel = detail.querySelector("#wb-e-dyn-col");
        if (!colSel) return;
        // 原 raw GET memory getdata?_t= → 复用 memory#getData 桥路由（缓存参数在桥侧无意义）
        const data = await sendAction({ verb: "getData", target: "plugins:beilu-memory", source: "web" }) || {};
        const tables = data.tables || data.code_tables || data.work_tables || [];
        const allCols = new Set();
        for (const t of tables) { for (const c of (t.columns || [])) allCols.add(c); }
        const curVal = e.dynamicConfig?.columnName || "";
        if (curVal) allCols.add(curVal);
        colSel.innerHTML = '<option value="">选择列...</option>' + [...allCols].map(c => `<option value="${_escHtml(c)}" ${c === curVal ? 'selected' : ''}>${_escHtml(c)}</option>`).join("");
      } catch (err) { console.warn("[wb] 拉表格列名失败:", err); }
    })();
    detail.querySelector("#wb-e-save")?.addEventListener("click", async () => {
      const status = detail.querySelector("#wb-e-status");
      try {
        const roleVal = detail.querySelector("#wb-e-role")?.value;
        const props = {
          comment: detail.querySelector("#wb-e-comment")?.value || "",
          disable: !detail.querySelector("#wb-e-enabled")?.checked,
          activationMode: detail.querySelector("#wb-e-mode")?.value || "regex",
          position: parseInt(detail.querySelector("#wb-e-position")?.value) || 0,
          depth: parseInt(detail.querySelector("#wb-e-depth")?.value) || 4,
          key: (detail.querySelector("#wb-e-keys")?.value || "").split(",").map(k => k.trim()).filter(Boolean),
          keysecondary: (detail.querySelector("#wb-e-keys2")?.value || "").split(",").map(k => k.trim()).filter(Boolean),
          useRegex: !!detail.querySelector("#wb-e-useregex")?.checked,
          role: roleVal === "" ? null : parseInt(roleVal),
          content: detail.querySelector("#wb-e-content")?.value || "",
        };
        // T6-C10: 删编造副本 100（后端 createBlankEntry/convertSTEntry/GetData 恒有 order）。
        // 排序权重解析失败时不提交，update_entry 走 Object.assign 保留原 order，不写假默认/NaN。
        const _orderVal = parseInt(detail.querySelector("#wb-e-order")?.value, 10);
        if (Number.isFinite(_orderVal)) props.order = _orderVal;
        if (props.activationMode === "dynamic") {
          props.dynamicConfig = {
            columnName: (detail.querySelector("#wb-e-dyn-col")?.value || "").trim(),
            matchType: detail.querySelector("#wb-e-dyn-match")?.value || "range",
            rangeMin: parseFloat(detail.querySelector("#wb-e-dyn-min")?.value) || 0,
            rangeMax: parseFloat(detail.querySelector("#wb-e-dyn-max")?.value) || 0,
            exactValue: detail.querySelector("#wb-e-dyn-exact")?.value || "",
          };
          if (!props.dynamicConfig.columnName) { if (status) status.textContent = "❌ 动态模式需填写列名"; return; }
        }
        // 原 POST setdata {update_entry:{...}} → 复用分身S 字段写路由 update_entry（buildBody 组装 {update_entry:payload}）；!ok 由门面抛错走 catch
        const _wbRes = await sendAction({ verb: "update_entry", target: "plugins:beilu-worldbook", source: "web", payload: { uid: entries[selectedEntry]?.uid, props } }) || {};
        // worldbook SetData 全族返回 {_result:{success,error}}（后端 main.mjs:1248 统一上浮，wbSetData facade 不 unwrap）——
        //   原读 _wbRes.success 恒 undefined 致失败静默过（guard 从不触发），改读 ._result 与本文件导出/重命名消费同源。
        const _wbResult = _wbRes._result || {};
        if (_wbResult.success === false) throw new Error(_wbResult.error || "保存失败");
        Object.assign(entries[selectedEntry], props);
        renderEntryList(container.querySelector("#wb-search")?.value);
        window.dispatchEvent(new CustomEvent("beilu-worldbook-changed"));
        if (status) status.textContent = "✅ 已保存";
        setTimeout(() => { if (status) status.textContent = ""; }, 2000);
      } catch (ex) { if (status) status.textContent = "❌ " + ex.message; }
    });
    detail.querySelector("#wb-e-delete")?.addEventListener("click", async () => {
      if (!await beiluConfirm("确定删除此条目？")) return;
      try {
        // 原 POST setdata {delete_entry:{...}} → 复用分身S 字段写路由 delete_entry
        await sendAction({ verb: "delete_entry", target: "plugins:beilu-worldbook", source: "web", payload: { uid: entries[selectedEntry]?.uid } });
        entries.splice(selectedEntry, 1); selectedEntry = null; render();
      } catch (e) { console.error('[layout] wb entry delete:', e); showToast("error", "删除世界书条目失败: " + (e?.message || e)); } // T021 弹出：用户删除操作失败必须可见
    });
  }

  function bindEvents() {
    container.querySelector("#wb-search")?.addEventListener("input", function() { renderEntryList(this.value); });
    container.querySelector("#wb-selector")?.addEventListener("change", async function() {
      try {
        // 原 POST setdata {switch_worldbook:{...}} → 复用分身S 字段写路由 switch_worldbook
        await sendAction({ verb: "switch_worldbook", target: "plugins:beilu-worldbook", source: "web", payload: { name: this.value } });
      } catch (e) { console.error('[layout] wb switch:', e); showToast("error", "切换世界书失败: " + (e?.message || e)); } // T021 弹出
      await loadData(); selectedEntry = null; render();
    });
    container.querySelector("#wb-add-entry")?.addEventListener("click", async () => {
      try {
        // 原 POST setdata {add_entry:{...}} → 复用分身S 字段写路由 add_entry
        await sendAction({ verb: "add_entry", target: "plugins:beilu-worldbook", source: "web", payload: { props: { comment: "新条目", content: "", key: [], activationMode: "regex" } } });
        await loadData(); selectedEntry = entries.length - 1; render();
      } catch (e) { console.error('[layout] wb add entry:', e); showToast("error", "新增世界书条目失败: " + (e?.message || e)); } // T021 弹出
    });
    container.querySelector("#wb-create")?.addEventListener("click", async () => {
      const name = await beiluPrompt("输入世界书名称：");
      if (!name?.trim()) return;
      try {
        // 原 POST setdata {create_worldbook:{...}} → 复用分身S 字段写路由 create_worldbook
        await sendAction({ verb: "create_worldbook", target: "plugins:beilu-worldbook", source: "web", payload: { name: name.trim() } });
        await loadData(); activeWb = name.trim(); render();
      } catch (e) { console.error('[layout] wb create:', e); }
    });
    // 孤儿verb期3·重命名世界书 → 字段写路由 rename_worldbook（后端 worldbook/main.mjs:1045，payload {old_name,new_name}）。
    //   名称源=当前 #wb-selector 选中值（非硬编码）；后端仅当 old 存在且 new 不存在时改（:1047 静默 no-op 不报错），
    //   故前端做同名/重名友好前置校验（后端仍是唯一权威守卫，前端不放松）。重命名激活书时后端自动跟进 active(:1053)。
    //   返回契约（亲读）：rename 无独立 return → 落 SetData 尾部统一磁盘写结果上浮 return {_result:{success}}（行号随文件漂移，锚功能不锚行）；wbSetData facade
    //   (prompt/index.mjs:111) 不 unwrap _result → sendAction unwrap 取 res.data → 前端拿 {_result:{success}}。
    container.querySelector("#wb-rename")?.addEventListener("click", async () => {
      const oldName = container.querySelector("#wb-selector")?.value || activeWb;
      if (!oldName) { showToast("error", "请先选择要重命名的世界书"); return; }
      const newName = await beiluPrompt(`重命名世界书「${oldName}」：`, oldName);
      const trimmed = newName?.trim();
      if (!trimmed || trimmed === oldName) return;
      if (worldbooks.includes(trimmed)) { showToast("error", `世界书「${trimmed}」已存在`); return; }
      try {
        const r = await sendAction({ verb: "rename_worldbook", target: "plugins:beilu-worldbook", source: "web", payload: { old_name: oldName, new_name: trimmed } }) || {};
        const rr = r._result || r; // 后端裹 {_result:{success}}，facade 不拆
        if (rr.success === false) throw new Error(rr.error || "重命名失败");
        await loadData(); activeWb = trimmed; selectedEntry = null; render();
        window.dispatchEvent(new CustomEvent("beilu-worldbook-changed"));
        showToast("success", `已重命名为「${trimmed}」`);
      } catch (e) { console.error('[layout] wb rename:', e); showToast("error", "重命名失败: " + (e?.message || e)); }
    });
    // 孤儿verb期3·导出世界书 → 字段写路由 export_worldbook（后端 worldbook/main.mjs:979，只读不落盘）。
    //   返回契约（亲读）：SetData 早 return {_result:{success,name,st_json}}（:986）；wbSetData facade(prompt/index.mjs:111)
    //   不 unwrap _result → sendAction unwrap 取 res.data → 前端拿 {_result:{success,name,st_json}}，故读 res._result。
    //   范式镜像预设导出（preset.mjs:793 Blob 下载）。
    container.querySelector("#wb-export")?.addEventListener("click", async () => {
      const name = container.querySelector("#wb-selector")?.value || activeWb;
      if (!name) { showToast("error", "请先选择要导出的世界书"); return; }
      try {
        const r = await sendAction({ verb: "export_worldbook", target: "plugins:beilu-worldbook", source: "web", payload: { name } }) || {};
        const res = r._result || r; // 后端裹 {_result:{success,name,st_json}}，facade 不拆
        if (!res.success || !res.st_json) { showToast("error", "导出失败: " + (res.error || "无 st_json")); return; }
        const blob = new Blob([res.st_json], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${res.name || name}.json`;
        a.click();
        URL.revokeObjectURL(url);
        showToast("success", `世界书「${res.name || name}」已导出`);
      } catch (e) { console.error('[layout] wb export:', e); showToast("error", "导出失败: " + (e?.message || e)); }
    });
    // 使用链审计0706·导入世界书 → 字段写路由 import_worldbook（后端 worldbook/main.mjs:975，payload {json,name,boundCharName?}）。
    //   契约（亲读）：json.entries 缺失=后端静默 no-op 不报错（:977）→ 前端先校验 entries；重名=后端直接覆盖（:983）→ 前端 beiluConfirm；
    //   导入默认 enabled=false（绑定=私有语义）且自动激活。返回落 SetData 尾部统一磁盘写结果上浮 return {_result:{success}}（锚功能不锚行），facade 不拆，自读 _result。
    //   范式镜像预设导入（#pp-import :626 FileReader + 重名确认 + recordImportHistory 上报集中历史）。
    container.querySelector("#wb-import")?.addEventListener("click", () => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".json,application/json";
      input.addEventListener("change", async () => {
        const file = input.files?.[0];
        if (!file) return;
        try {
          const json = JSON.parse(await file.text());
          if (!json?.entries || typeof json.entries !== "object") { showToast("error", "不是有效的 ST lorebook JSON（缺 entries 字段）"); return; }
          const defName = file.name.replace(/\.json$/i, "");
          const name = (await beiluPrompt("导入为世界书名称：", defName))?.trim();
          if (!name) return;
          if (worldbooks.includes(name) && !(await beiluConfirm(`世界书「${name}」已存在，导入将覆盖其全部条目，继续？`))) return;
          const r = await sendAction({ verb: "import_worldbook", target: "plugins:beilu-worldbook", source: "web", payload: { json, name } }) || {};
          const rr = r._result || r; // 后端裹 {_result:{success}}，facade 不拆
          if (rr.success === false) throw new Error(rr.error || "导入失败");
          await loadData(); activeWb = name; selectedEntry = null; render();
          window.dispatchEvent(new CustomEvent("beilu-worldbook-changed"));
          recordImportHistory("世界书", name); // T033：上报集中导入历史（聚合面板历史区可见）
          showToast("success", `世界书「${name}」已导入（默认关闭，绑定/启用后生效）`);
        } catch (e) { console.error('[layout] wb import:', e); showToast("error", "导入失败: " + (e?.message || e)); }
      });
      input.click();
    });
    // 使用链审计0706·删除世界书 → 字段写路由 delete_worldbook（后端 worldbook/main.mjs:1006，payload {name}）。
    //   契约（亲读）：不存在=静默 no-op（:1008）；删激活书后端自动切换其余第一本（:1012）。返回 {_result:{success}}。
    //   删除不可恢复 → beiluConfirm 前置守卫（后端无回收站）。
    container.querySelector("#wb-delete")?.addEventListener("click", async () => {
      const name = container.querySelector("#wb-selector")?.value || activeWb;
      if (!name) { showToast("error", "请先选择要删除的世界书"); return; }
      if (!(await beiluConfirm(`确认删除世界书「${name}」？其全部条目将被删除，不可恢复。`))) return;
      try {
        const r = await sendAction({ verb: "delete_worldbook", target: "plugins:beilu-worldbook", source: "web", payload: { name } }) || {};
        const rr = r._result || r; // 后端裹 {_result:{success}}，facade 不拆
        if (rr.success === false) throw new Error(rr.error || "删除失败");
        await loadData(); selectedEntry = null; render();
        window.dispatchEvent(new CustomEvent("beilu-worldbook-changed"));
        showToast("success", `世界书「${name}」已删除`);
      } catch (e) { console.error('[layout] wb delete:', e); showToast("error", "删除失败: " + (e?.message || e)); }
    });
  }

  await loadData();
  render();
}

export { _loadPersonaEditor, _loadPresetPanel, _loadInjPanel, _loadWorldbookInline, _openCharEditDialog };

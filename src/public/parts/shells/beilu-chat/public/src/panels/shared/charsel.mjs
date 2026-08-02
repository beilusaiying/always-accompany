/**
 * charsel.mjs — 顶部角色卡选择悬浮窗 cluster
 *
 * 功能链：用户点击顶部「角色名」按钮 → 弹出全屏 overlay → 从 /api/getallcacheddetails/chars 拉取角色列表
 *   → 渲染大图 grid（含搜索过滤/收藏排序）→ 点击角色卡调用 switchCharacterScope() 切换角色
 *   → 收藏状态存 localStorage；导入走文件 input（.json/.png）；新建打开 _openCharEditDialog()
 * why：角色卡选择是高频操作，需要带图片预览的 home 风格 grid 而非简单下拉，从 layout.mjs 抽出独立管理
 * 关联链：被 layout.mjs import（_initCharSelectorDropdown 在 initLayout 时调用）；
 *   import panels.mjs（_openCharEditDialog 编辑角色卡）、chat.mjs（switchCharacterScope）、core.mjs（layoutState/saveState）
 * 影响范围：改动影响顶部角色名点击后的悬浮窗 UI、角色切换逻辑、收藏排序、头像加载策略
 * 使用效果：用户点击顶部角色名弹出大图选角面板，可搜索/收藏/导入/新建角色卡，点选后立即切换当前对话角色
 */
import { escapeHtml, resolveAvatar } from "../../shared/state/utils.mjs";
import { apiFetch } from "../../shared/transport/api-client.mjs"; // T6b：仅保留角色卡导出（blob 二进制流，门面非 raw 不适用，R1-SKIP 登记）
import { sendAction } from "../../shared/transport/sendAction.mjs"; // T6b：出向统一门面（chars 列表/chat 列表/新建/加角色/导入/建角色 走门面）
import { storage, KEYS } from "../../shared/state/storage.mjs";
import { switchCharacterScope, chatBelongsToChar } from "../../shared/chat-core/chat.mjs";
import { _openCharEditDialog } from "../settings/panels.mjs";
import { layoutState, saveState } from "../../shared/layout/core.mjs";
import { beiluPrompt } from "../../shared/widgets/beiluDialog.mjs";
import { recordImportHistory } from "../settings/importExport.mjs"; // T033：导入成功上报集中历史（聚合层唯一权威）
const _escHtml = escapeHtml; // 共享 alias（layout.mjs:24 同名,不随迁,此处自备）

// W54: 角色卡选择悬浮窗（beilu-home风格大图grid + 搜索 + 导入 + 新建）
// ============================================================

// [0720 显示/拉取解耦·凛倾拍板「显示不应该只是显示角色卡,点击切换才重新拉」]
// 上次 listAllCached 结果的模块级缓存：再次打开弹窗立即渲染（展示层消费缓存,零"加载中"等待），
// 后台静默校准 + beilu:chars-changed 事件驱动增量维持新鲜。仅首次（无缓存）阻塞拉取。
let _charListCache = null; // { cachedDetails, uncachedNames } 快照

function _initCharSelectorDropdown() {
  const btn = document.getElementById("header-char-name");
  const overlay = document.getElementById("char-selector-overlay");
  if (!btn || !overlay) return;

  let _refreshFn = null;
  function closeOverlay() { overlay.classList.add("hidden"); _refreshFn = null; }

  window.addEventListener("beilu:chars-changed", async () => {
    if (overlay.classList.contains("hidden") || !_refreshFn) {
      // 弹窗关着时角色集变了（删除/导入/改名）→ 模块缓存失效，下次打开重新拉取，
      // 防"缓存先行"渲染出已删角色的幽灵卡
      _charListCache = null;
      return;
    }
    await _refreshFn();
  });

  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!overlay.classList.contains("hidden")) { closeOverlay(); return; }

    overlay.classList.remove("hidden");
    overlay.innerHTML = `<div class="char-modal" style="position:relative">
      <button class="char-modal-close" title="关闭">✕</button>
      <div class="char-modal-header">
        <input type="text" id="char-search-input" placeholder="🔍 搜索角色卡..." />
        <label class="char-action-btn"><i data-ic="download"></i> 导入<input type="file" accept=".json,.png" multiple style="display:none" id="char-import-input" /></label>
        <button class="char-action-btn" id="char-new-btn"><i data-ic="sparkles"></i> 新建</button>
      </div>
      <div class="char-grid" id="char-grid">
        <div style="grid-column:1/-1;text-align:center;padding:40px;opacity:0.4">加载中...</div>
      </div>
    </div>`;

    // 关闭按钮
    overlay.querySelector(".char-modal-close")?.addEventListener("click", closeOverlay);

    // 点击overlay背景关闭
    overlay.addEventListener("click", (ev) => { if (ev.target === overlay) closeOverlay(); });

    try {
      // 缓存先行：有上次结果立即渲染，不发请求不等待；首次才阻塞拉取（!ok 由门面抛错走外层 catch，grid 显示"加载失败"）
      let _listResult = _charListCache;
      const _openedFromCache = !!_listResult;
      if (!_listResult) {
        _listResult = await sendAction({ verb: "listAllCached", target: "server:chars", source: "web" });
        _charListCache = _listResult;
      }
      const cachedDetails = { ...(_listResult?.cachedDetails || {}) };
      const uncachedNames = [...(_listResult?.uncachedNames || [])];
      const charNames = [...Object.keys(cachedDetails), ...uncachedNames];

      let favorites = [];
      try { favorites = JSON.parse(storage.get(KEYS.BEILU_CHAR_FAVORITES) || "[]"); } catch {}

      const currentChar = document.getElementById("header-char-name-text")?.textContent || "";

      function getAvatarUrl(name) {
        const details = cachedDetails[name];
        // uncached 角色（details 为 undefined）：仍走懒加载尝试默认 image.png（img onerror 兜底）
        if (!details) return `/parts/chars:${encodeURIComponent(name)}/image.png`;
        // details 已加载：C7 统一契约——avatar 非空解析路径，空串/缺失/宏均显式 fallback（后端契约 main.mjs:56-58）
        return resolveAvatar({ avatar: details.info?.avatar, kind: "chars", name });
      }

      const gridEl = overlay.querySelector("#char-grid");
      const searchInput = overlay.querySelector("#char-search-input");

      function renderGrid(filter) {
        const filtered = filter ? charNames.filter(n => n.toLowerCase().includes(filter.toLowerCase())) : charNames;
        const sorted = [...filtered].sort((a, b) => {
          const aFav = favorites.includes(a) ? 0 : 1;
          const bFav = favorites.includes(b) ? 0 : 1;
          return aFav - bFav;
        });

        gridEl.innerHTML = sorted.map(name => {
          const isFav = favorites.includes(name);
          const isActive = name === currentChar;
          const avatarUrl = getAvatarUrl(name);
          const _n = _escHtml(name);
          return `<div class="char-card ${isActive ? 'active' : ''}" data-char="${_n}">
            <div class="char-card-img">
              <img src="${_escHtml(avatarUrl)}" onerror="this.style.display='none';this.parentElement.textContent='🎭'" loading="lazy" />
            </div>
            <div class="char-card-info">
              <span class="char-card-name" title="${_n}">${_n}</span>
              <button class="char-card-edit" data-edit="${_n}" title="编辑角色卡"><i data-ic="settings"></i></button>
              <button class="char-card-export" data-export="${_n}" title="导出角色卡 (PNG)"><i data-ic="upload"></i></button>
              <button class="char-card-fav" data-fav="${_n}" title="${isFav ? '取消收藏' : '收藏'}">${isFav ? '<i data-ic="star"></i>' : '<i data-ic="star-o"></i>'}</button>
            </div>
          </div>`;
        }).join("") || '<div style="grid-column:1/-1;text-align:center;padding:40px;opacity:0.4">无匹配角色卡</div>';

        // 点击卡片切换角色
        gridEl.querySelectorAll(".char-card").forEach(card => {
          card.addEventListener("click", async (ev) => {
            if (ev.target.closest(".char-card-fav")) return;
            const charName = card.dataset.char;
            if (charName === currentChar) { closeOverlay(); return; }
            closeOverlay();
            try {
              // [R6 身份收口 0713] 桥=commitCurrentChar（运行时+持久键一次写齐），原并排 storage.set 直写删除。
              window._beiluSetCharName?.(charName);
              // W61修复: 角色切换时查找该角色的专属聊天（优先primaryCharName精确匹配）
              // 1. 查找新角色的已有聊天
              // ★ 后端路由失败(如 chat shell 未加载→404)必须可见报错，不能当"无聊天"静默 reload：
              //   getchatlist 404 时切换会无声失败、卡在原角色，用户无从察觉。门面 !ok 抛错→本地 catch 保留原专属提示后中止（fail-loud 语义一字不动）。
              let targetChatId = null;
              let allChats;
              try {
                allChats = await sendAction({ verb: "getChatList", target: "shells:chat", source: "web" });
              } catch (listErr) {
                window._beiluToast?.(`切换角色失败：聊天列表接口异常 (${listErr.message})。chat shell 可能未正常加载，请检查后端日志。`, "error");
                console.error(`[charSelector] getchatlist 失败 — 后端 chat shell 路由不可用，中止切换`, listErr);
                return;
              }
              {
                // 单一权威：与 initializeChat 的 resolveChatIdForChar 用同一归属判定 chatBelongsToChar
                // （primaryCharName 精确 OR chars 包含），不再用三层 exact/primary/chars 分叉规则。
                // getchatlist 已按时间倒序 → find 取最近一条属于该角色的聊天。绝不跨角色回退。
                const mine = Array.isArray(allChats)
                  ? allChats.find(c => chatBelongsToChar(c, charName))
                  : null;
                if (mine) {
                  targetChatId = mine.chatid || mine.id;
                  console.log(`[charSelector] 角色「${charName}」最近聊天: ${targetChatId}`);
                }
              }
              // 2. 没找到则创建新聊天并添加角色（4模式各建一条，切模式tab不空白）
              if (!targetChatId) {
                console.log(`[charSelector] 角色「${charName}」无已有聊天，创建4模式对话`);
                const ALL_MODES = ["chat", "smart", "code", "work"];
                let chatModeId = null;
                try {
                  const { classifyNewChat } = await import("../../shared/chat-core/conversationManager.mjs");
                  for (const mode of ALL_MODES) {
                    let newData;
                    try {
                      newData = await sendAction({ verb: "new", target: "shells:chat", source: "web" });
                    } catch (newErr) {
                      if (mode === "chat") {
                        window._beiluToast?.(`切换角色失败：新建聊天接口异常 (${newErr.message})。chat shell 可能未正常加载。`, "error");
                        console.error(`[charSelector] new 失败 — 中止切换`, newErr);
                        return;
                      }
                      console.warn(`[charSelector] ${mode} 模式对话创建失败，跳过`, newErr);
                      continue;
                    }
                    const cid = newData.chatid;
                    await sendAction({ verb: "bindCharToChat", target: "shells:chat", source: "web", scope: { chatId: cid }, payload: { charname: charName } });
                    try { classifyNewChat(cid, charName, mode); } catch {}
                    if (mode === "chat") chatModeId = cid;
                  }
                } catch (outerErr) {
                  console.error(`[charSelector] 4模式创建异常`, outerErr);
                }
                targetChatId = chatModeId;
              }
              // 3. 跳转到目标聊天（切回chat Tab，避免停留在工作/IDE Tab）
              layoutState.activeTab = "chat";
              saveState();
              if (targetChatId) {
                // 切卡免刷：先切回 chat Tab（无 reload，需显式切 Tab），再运行时切换对话
                try { window.dispatchEvent(new CustomEvent("beilu:switchTab", { detail: { tab: "chat" } })); } catch {}
                await switchCharacterScope(targetChatId, charName);
              } else {
                // 无目标聊天 → 空态，保留整页 reload
                window.location.hash = "";
                window.location.reload();
              }
            } catch (e) {
              console.error("[charSelector] 切换角色失败:", e);
              window._beiluToast?.("切换角色失败: " + e.message, "error");
            }
          });
        });

        // 编辑按钮
        gridEl.querySelectorAll(".char-card-edit").forEach(ebtn => {
          ebtn.addEventListener("click", (ev) => {
            ev.stopPropagation();
            _openCharEditDialog(ebtn.dataset.edit, cachedDetails[ebtn.dataset.edit] || {}, () => renderGrid(searchInput?.value || ""));
          });
        });

        // 导出按钮
        gridEl.querySelectorAll(".char-card-export").forEach(xbtn => {
          xbtn.addEventListener("click", async (ev) => {
            ev.stopPropagation();
            const cn = xbtn.dataset.export;
            try {
              const resp = await apiFetch(`/api/parts/shells:chat/char/${encodeURIComponent(cn)}/export?format=png`, { raw: true });
              if (!resp.ok) { const e = await resp.json().catch(() => ({})); window._beiluToast?.("导出失败: " + (e.message || resp.status), "error"); return; }
              const blob = await resp.blob();
              // 后端无头像时自动降级 JSON（Content-Type 区分），前端据此调整文件名
              const ct = resp.headers.get("Content-Type") || "";
              const ext = ct.includes("application/json") ? ".json" : ".png";
              const a = document.createElement("a");
              a.href = URL.createObjectURL(blob);
              a.download = cn + ext;
              a.click();
              URL.revokeObjectURL(a.href);
              window._beiluToast?.("角色卡已导出: " + cn + ext, "success");
            } catch (err) { window._beiluToast?.("导出失败: " + err.message, "error"); }
          });
        });

        // 收藏按钮（[0713 病灶审计 A2] 点击时以 storage 为准重读再回写——原闭包旧表整表覆盖，
        //   会把面板打开期间别处（panels.mjs 删角色清理）已移除的名字复活=反向回灌）
        gridEl.querySelectorAll(".char-card-fav").forEach(fbtn => {
          fbtn.addEventListener("click", (ev) => {
            ev.stopPropagation();
            const charName = fbtn.dataset.fav;
            let fresh = [];
            try { fresh = JSON.parse(storage.get(KEYS.BEILU_CHAR_FAVORITES) || "[]"); } catch {}
            const idx = fresh.indexOf(charName);
            if (idx >= 0) fresh.splice(idx, 1);
            else fresh.push(charName);
            try { storage.set(KEYS.BEILU_CHAR_FAVORITES, JSON.stringify(fresh)); } catch {}
            favorites = fresh; // 闭包渲染态与持久层对齐（星标/排序读它）
            renderGrid(searchInput?.value || "");
          });
        });
      }

      renderGrid("");
      searchInput?.addEventListener("input", () => renderGrid(searchInput.value));
      searchInput?.focus();

      _refreshFn = async () => {
        try {
          // 原 raw GET chars 缓存详情 + rr.ok 手检 → 复用 listAllCached；!ok 由门面抛错走 catch（原 console.warn 外部刷新失败）
          const rd = await sendAction({ verb: "listAllCached", target: "server:chars", source: "web" });
          const nc = rd?.cachedDetails || {};
          const nu = rd?.uncachedNames || [];
          _charListCache = { cachedDetails: { ...nc }, uncachedNames: [...nu] }; // 模块缓存同步快照（下次打开秒开）
          for (const k of Object.keys(cachedDetails)) delete cachedDetails[k];
          Object.assign(cachedDetails, nc);
          charNames.length = 0;
          charNames.push(...Object.keys(nc), ...nu);
        } catch (e) { console.warn("[charSelector] 外部刷新失败:", e.message); }
        // overlay 已关时只更新缓存不渲染（closeOverlay 后的迟到校准无 UI 意义）
        if (!overlay.classList.contains("hidden")) renderGrid(searchInput?.value || "");
      };

      // 缓存先行打开时后台静默校准：复用 _refreshFn 同一刷新链（更新闭包数据+缓存+重渲）
      if (_openedFromCache) _refreshFn().catch(() => {});

      // 导入角色卡（增量刷新：不 reload，重新拉列表 + 渲染 grid + 切到新导入角色）
      overlay.querySelector("#char-import-input")?.addEventListener("change", async (ev) => {
        const files = ev.target.files;
        if (!files?.length) return;
        let lastImportedName = null;
        let lastImportResp = null; // [0731] 服务端 import-char 响应带 modeChats（四窗口对话表），导入后跳转直接用
        for (const file of files) {
          try {
            const formData = new FormData();
            formData.append("file", file);
            // 原 raw POST import-char（FormData）+ resp.ok 手检 → 门面 importChar（payload._form=FormData 直传，apiFetch 识别不 JSON 化）；!ok 由门面抛错走 catch
            const importResult = await sendAction({ verb: "importChar", target: "shells:chat", source: "web", payload: { _form: formData } });
            lastImportedName = importResult.name || null;
            lastImportResp = importResult;
            window._beiluToast?.(`✅ 导入 ${file.name} 成功`, "success");
            recordImportHistory("角色卡", importResult.name || file.name); // T033：上报集中导入历史

          } catch (e) {
            window._beiluToast?.(`❌ 导入 ${file.name} 失败: ${e.message}`, "error");
          }
        }
        // 增量刷新角色卡列表（重新拉 cachedDetails 更新闭包内数组/对象）
        try {
          // 原 raw GET chars 缓存详情 + refreshRes.ok 手检 → 复用 listAllCached；!ok 由门面抛错走 catch（原 console.warn 导入后刷新失败）
          const refreshResult = await sendAction({ verb: "listAllCached", target: "server:chars", source: "web" });
          const newCached = refreshResult?.cachedDetails || {};
          const newUncached = refreshResult?.uncachedNames || [];
          _charListCache = { cachedDetails: { ...newCached }, uncachedNames: [...newUncached] }; // 模块缓存同步快照
          // 更新闭包内 cachedDetails（清空旧键 + 合入新键）
          for (const k of Object.keys(cachedDetails)) delete cachedDetails[k];
          Object.assign(cachedDetails, newCached);
          // 更新闭包内 charNames（清空 + 重填，保持同一数组引用）
          charNames.length = 0;
          charNames.push(...Object.keys(newCached), ...newUncached);
        } catch (e) {
          console.warn("[charSelector] 导入后刷新列表失败:", e.message);
        }
        renderGrid(searchInput?.value || "");
        // 切到最后导入的角色（与新建角色同模式：创建聊天 + switchCharacterScope）
        if (lastImportedName) {
          closeOverlay();
          try {
            // [R6 身份收口 0713] 桥=commitCurrentChar（运行时+持久键一次写齐），原并排直写删除。
            window._beiluSetCharName?.(lastImportedName);
            // [0731 四窗口对话收口] 四模式对话由服务端 import-char 内 ensureModeChatsForChar 保障
            //   （幂等：已有线返现值、缺失线新建），响应 modeChats 直接给跳转目标。
            //   原"getChatList 查到任一已有对话就跳过建对话"短路删除——角色卡初始化会自动绑进
            //   当前对话导致恒"已有"，四对话循环从未执行过（0731 一条对话被三窗共用的根因）。
            const targetChatId = lastImportResp?.modeChats?.chat || null;
            if (targetChatId) {
              layoutState.activeTab = "chat";
              saveState();
              try { window.dispatchEvent(new CustomEvent("beilu:switchTab", { detail: { tab: "chat" } })); } catch {}
              await switchCharacterScope(targetChatId, lastImportedName);
            }
          } catch (switchErr) {
            console.warn("[charSelector] 导入后切换角色失败:", switchErr.message);
          }
        }
      });

      // 新建角色卡 — 只创建角色，初始化时自动绑定到当前聊天
      overlay.querySelector("#char-new-btn")?.addEventListener("click", async () => {
        const name = await beiluPrompt("输入新角色卡名称：");
        if (!name?.trim()) return;
        try {
          const charName = name.trim();
          // 原 raw POST create-char {name} + resp.ok 手检（!ok 读 body.error）→ 门面 createChar；!ok 由门面抛错（apiFetch 已解析 body.error 进消息）走 catch
          // [0731 四窗口对话收口] 四模式对话由服务端 create-char 内 ensureModeChatsForChar 建好并挂
          //   「在用」指针，响应带 modeChats 四键表。原前端四模式循环（与导入路径复制两份，且循环内
          //   classifyNewChat 只是前端双写）随收口镜像删除——服务端单点保证任何建卡入口行为一致。
          const createResp = await sendAction({ verb: "createChar", target: "shells:chat", source: "web", payload: { name: charName } });
          // [R6 身份收口 0713] 桥=commitCurrentChar（运行时+持久键一次写齐），原并排直写删除。
          window._beiluSetCharName?.(charName);
          window._beiluToast?.(`✅ 创建角色「${charName}」成功`, "success");
          closeOverlay();
          try {
            const primaryChatId = createResp?.modeChats?.chat || null;
            if (!primaryChatId) throw new Error("服务端未返回 chat 窗口对话（modeChats.chat 缺失）");
            layoutState.activeTab = "chat";
            saveState();
            try { window.dispatchEvent(new CustomEvent("beilu:switchTab", { detail: { tab: "chat" } })); } catch {}
            await switchCharacterScope(primaryChatId, charName);
          } catch (switchErr) {
            console.warn("[charSelector] 新建后切换角色失败:", switchErr.message);
            window.location.reload();
          }
        } catch (e) {
          window._beiluToast?.(`❌ 创建失败: ${e.message}`, "error");
        }
      });

    } catch (err) {
      const gridEl = overlay.querySelector("#char-grid");
      if (gridEl) gridEl.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:40px;color:red">加载失败: ${err.message}</div>`;
    }
  });

  // ESC关闭
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !overlay.classList.contains("hidden")) closeOverlay();
  });
}

export { _initCharSelectorDropdown };

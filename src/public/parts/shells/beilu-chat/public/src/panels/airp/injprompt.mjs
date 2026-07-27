/**
 * @file injprompt.mjs — 注入提示词列表（CRUD）cluster
 *
 * 【功能链】
 *   initInjectionPromptList（入口，绑定编辑入口按钮 → dispatch beilu:openEditorTab）
 *   → loadList（GET beilu-memory/config/getdata?char_id=... → 取 injection_prompts；
 *       同时 fetch char-data 获取角色卡 depth_prompt，渲染时去重）
 *   → renderList（渲染每条注入提示词为折叠行：启用/禁用 toggle、点击展开内容预览）
 *   → 启用/禁用 toggle（POST MEMORY_API_SET 持久化开关状态）
 *   → 增/删操作（POST MEMORY_API_SET，操作后 loadList 刷新）
 *
 * 【why】
 *   注入提示词（injection_prompts）是 beilu-memory 插件的核心数据之一，
 *   右栏需提供轻量 CRUD 入口；编辑重操作已迁移到 panels/settings/panels.mjs 的专用编辑器，
 *   此模块仅保留列表展示 + 启用禁用 + 跳转编辑入口。
 *   同时展示角色卡 depth_prompt 层注入，让用户感知全部注入来源。
 *
 * 【关联链】
 *   上游：index.mjs（调用 initInjectionPromptList）
 *   同层依赖：utils.mjs（escapeHtml / showToast / getCurrentCharId）
 *   核心依赖：shared/widgets/beiluDialog.mjs（beiluConfirm 删除确认）、
 *             shared/transport/api-client.mjs（apiFetch）
 *   后端接口：beilu-memory /config/getdata（读）、/config/setdata（写）；
 *             shells:chat /char-data/:charId（读 depth_prompt）
 *   下游事件：dispatch beilu:openEditorTab "inj-edit"（跳转编辑面板）
 *
 * 【影响范围】
 *   右栏注入提示词折叠组 UI；beilu-memory 插件存储的 injection_prompts 数据；
 *   启用/禁用状态影响 AI 每次生成时的提示词注入结果。
 *
 * 【使用效果】
 *   import { initInjectionPromptList } from "./injprompt.mjs"
 *   初始化后右栏展示全部注入提示词（含角色卡 depth_prompt），
 *   可一键启用/禁用，点击编辑按钮跳转到专用编辑器。
 */
import { escapeHtml, showToast, getCurrentCharId } from "./utils.mjs";
import { beiluConfirm } from "../../shared/widgets/beiluDialog.mjs";
import { sendAction } from "../../shared/transport/sendAction.mjs"; // T6b批7：出向统一门面（verb=真动作），beilu-memory getdata/setdata + char-data 收口

// ============================================================
// 注入提示词列表（右栏折叠组）
// ============================================================

/**
 * 初始化注入提示词列表（CRUD 完整版）
 * 从 beilu-memory 插件获取 injection_prompts 并渲染到右栏折叠组
 * 支持：启用/禁用切换、点击展开编辑、添加/删除条目
 */
async function initInjectionPromptList() {
  const listEl = document.getElementById("injection-prompt-list");
  const refreshBtn = document.getElementById("injection-prompt-refresh");
  const editOpenBtn = document.getElementById("injection-prompt-edit-open"); // AIRP-T2: 新编辑入口
  // [0713 病灶审计 H1] AIRP-T2 删内联编辑器 DOM 后残留的配对 JS（editorEl/inj-edit-* 常量、
  //   openEditor 填充/保存/取消/添加整段——元素全 null 不可达死代码）已纯删；
  //   编辑/新增入口 = 编辑弹窗注入 tab（dispatch beilu:openEditorTab "inj-edit"，panels.mjs 编辑器）。
  if (!listEl) return;

  // INJ浮窗已删除，直接打开编辑界面注入tab
  editOpenBtn?.addEventListener("click", () => {
    window.dispatchEvent(new CustomEvent("beilu:openEditorTab", { detail: "inj-edit" }));
  });

  // T6b批7：MEMORY_API_SET URL 常量收口进 sendAction 门面（beilu-memory#* 通配路由）。

  /** 当前缓存的注入提示词数据 */
  let _injPrompts = [];

  /**
   * 从后端加载注入提示词列表并渲染
   */
  /** 角色卡 depth_prompt 缓存（用于 renderList 去重） */
  let _charDepthPrompt = null;

  async function loadList() {
    listEl.textContent = "加载中...";
    try {
      const charId = getCurrentCharId();
      // T6b批7：getdata?char_id → sendAction beilu-memory#getData（桥路由，payload 进 dispatch args；
      //   后端 getDataHandler `charName = args.char_id`）。!ok 由门面抛错走外层 catch（原 `if(!resp.ok) throw` 等价）。
      const data = await sendAction({ verb: "getData", target: "plugins:beilu-memory", source: "web", payload: charId ? { char_id: charId } : {} });
      _injPrompts = data.injection_prompts || [];

      // F-C: 从角色卡 chardata 获取 depth_prompt（角色卡层注入提示词）
      _charDepthPrompt = null;
      if (charId) {
        try {
          // T6b批7：GET /char-data/:charId → sendAction shells:chat#getCharData。!ok 门面抛错走本 try catch（原 charResp.ok 为假时 _charDepthPrompt 保持 null，等价）。
          const charData = await sendAction({ verb: "getCharData", target: "shells:chat", source: "web", payload: { charId } });
          {
            // SillyTavern V2: data.extensions.depth_prompt；V1: 直接 extensions.depth_prompt
            const ext =
              charData?.data?.extensions || charData?.extensions || {};
            if (ext.depth_prompt && ext.depth_prompt.prompt) {
              _charDepthPrompt = {
                id: "CHAR_DEPTH_PROMPT",
                name: "角色卡注入 (depth_prompt)",
                content: ext.depth_prompt.prompt,
                role: ext.depth_prompt.role || "system",
                depth: ext.depth_prompt.depth ?? 4,
                enabled: true,
                builtin: true,
                deletable: false,
                _fromCharData: true,
              };
            }
          }
        } catch (err) {
          console.warn(
            "[beilu-chat] 获取角色卡 depth_prompt 失败:",
            err.message,
          );
        }
      }

      // 去重：如果角色卡 depth_prompt 内容与某个 INJ 条目完全相同，过滤掉该 INJ
      let displayPrompts = _injPrompts;
      if (_charDepthPrompt) {
        const charContent = _charDepthPrompt.content.trim();
        displayPrompts = _injPrompts.filter((p) => {
          const pContent = (p.content || p.content_preview || "").trim();
          return pContent !== charContent;
        });
        // 角色卡 depth_prompt 排在列表最前面
        displayPrompts = [_charDepthPrompt, ...displayPrompts];
      }

      renderList(displayPrompts);
    } catch (err) {
      listEl.innerHTML = `<p class="text-xs text-error text-center py-2">加载失败: ${escapeHtml(err.message)}</p>`;
    }
  }

  /**
   * 渲染注入提示词列表
   * @param {Array} prompts
   */
  function renderList(prompts) {
    if (prompts.length === 0) {
      // [0727 上线引导] 空态补概念说明:「注入提示词」是高门槛自有概念,原空态只报无,不解释是什么
      listEl.innerHTML =
        '<p class="text-xs text-base-content/40 text-center py-2">暂无注入提示词(注入提示词会随每次生成自动附加进上下文)</p>';
      return;
    }

    listEl.innerHTML = "";
    prompts.forEach((p) => {
      const item = document.createElement("div");
      const isFromChar = p._fromCharData === true;
      item.className =
        "flex items-center gap-1.5 py-1 px-1 rounded text-xs hover:bg-base-300/30 cursor-pointer group" +
        (isFromChar ? " border-l-2" : "");
      if (isFromChar) item.style.borderColor = "var(--beilu-amber-50)";
      item.dataset.injId = p.id;

      // 删除语义统一（凛倾0722：无论什么都可以删，但加上提示）：与设置页编辑器同口径，
      //   不再按 deletable 挡按钮（原双口径：这里挡、编辑器不挡）；角色卡条目除外（来源域不同，非本表数据）。
      const deletable = !isFromChar;
      item.innerHTML = `
    <input type="checkbox" class="checkbox checkbox-xs checkbox-success inj-toggle"
    	data-inj-id="${escapeHtml(p.id)}" ${p.enabled ? "checked" : ""} ${isFromChar ? "disabled" : ""} title="${isFromChar ? "由角色卡定义，始终启用" : "启用/禁用"}" />
    <span class="flex-1 truncate inj-name-label">${escapeHtml(p.name || p.id)}</span>
    ${isFromChar ? '<span class="badge badge-xs badge-warning" title="来自角色卡 chardata">角色卡</span>' : ""}
    <span class="badge badge-xs opacity-40">${escapeHtml(p.role || "system")}</span>
    ${deletable ? `<button class="btn btn-ghost btn-xs opacity-0 group-hover:opacity-60 inj-delete-btn" data-inj-id="${escapeHtml(p.id)}" title="删除"><i data-ic="trash"></i></button>` : ""}
   `;

      // 点击条目 → 展开编辑面板
      item.addEventListener("click", (e) => {
        if (
          e.target.classList.contains("inj-toggle") ||
          e.target.classList.contains("inj-delete-btn")
        )
          return;
        openEditor();
      });

      // checkbox → 启用/禁用切换
      const cb = item.querySelector(".inj-toggle");
      cb.addEventListener("change", async (e) => {
        e.stopPropagation();
        await toggleInjPrompt(p.id, cb.checked);
      });

      // 删除按钮
      if (deletable) {
        const delBtn = item.querySelector(".inj-delete-btn");
        delBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          await deleteInjPrompt(p.id, p.name || p.id, p);
        });
      }

      listEl.appendChild(item);
    });
  }

  /**
   * 切换注入提示词的启用/禁用状态
   * @param {string} injId
   * @param {boolean} enabled
   */
  async function toggleInjPrompt(injId, enabled) {
    const charId = getCurrentCharId();
    try {
      // T6b批7：setdata {_action:updateInjectionPrompt} → sendAction beilu-memory#*（通配组装）。!ok 门面抛错走 catch（原 `if(!resp.ok) throw` 等价）。
      await sendAction({
        verb: "updateInjectionPrompt",
        target: "plugins:beilu-memory",
        source: "web",
        payload: { injectionId: injId, enabled, charName: charId || "_global" },
      });
      // 更新本地缓存
      const p = _injPrompts.find((x) => x.id === injId);
      if (p) p.enabled = enabled;

      // 同步 INJ-2 状态缓存：_inj2Enabled 归 index-memoryai 簇所有，经 window._beiluSyncInj2State
      // 单源同步（同时刷 #inj2-status）。拆分后本模块不再持有该 state，直接赋值会 ReferenceError；
      // optional chaining 让 memoryai 未懒载时 no-op 降级。
      if (injId === "INJ-2") {
        window._beiluSyncInj2State?.(enabled);
        // T04: 同步 layout.mjs 的 dirty check 缓存，手动开关后 switchTab 不会跳过已变的值
        window._beiluSyncInj2LastEnabled?.(enabled);
      }
    } catch (err) {
      showToast(`切换失败: ${err.message}`, "error");
      await loadList();
    }
  }

  /**
   * 删除注入提示词
   * @param {string} injId
   * @param {string} displayName
   */
  async function deleteInjPrompt(injId, displayName, entry = null) {
    // 分级提示（凛倾0722：皆可删但加提示）：数据模板/内置条目说明后果+找回途径，与设置页编辑器同文案口径
    const _warn = entry?.dataDriven
      ? `「${displayName}」是数据模板条目，删除后对应功能数据（检索/委派/搜索结果等）将不再注入对话。「恢复默认」可找回。确认删除？`
      : entry?.builtin
        ? `「${displayName}」是内置条目，删除后相关功能提示不再注入。「恢复默认」可找回。确认删除？`
        : `确定删除注入提示词 "${displayName}" 吗？`;
    if (!await beiluConfirm(_warn)) return;
    const charId = getCurrentCharId();
    try {
      // T6b批7：setdata {_action:deleteInjectionPrompt} → sendAction beilu-memory#*（通配组装）。!ok 门面抛错走 catch。
      const result = await sendAction({
        verb: "deleteInjectionPrompt",
        target: "plugins:beilu-memory",
        source: "web",
        payload: { injectionId: injId, charName: charId || "_global" },
      });
      if (result.error) throw new Error(result.error);
      showToast(`已删除: ${displayName}`, "success");
      await loadList();
    } catch (err) {
      showToast(`删除失败: ${err.message}`, "error");
    }
  }

  /**
   * 打开编辑入口：内联编辑器已删（AIRP-T2），点击条目 → 打开编辑弹窗注入 tab
   */
  function openEditor() {
    window.dispatchEvent(new CustomEvent("beilu:openEditorTab", { detail: "inj-edit" }));
  }

  // 初始加载
  await loadList();
  refreshBtn?.addEventListener("click", loadList);
}

export { initInjectionPromptList };

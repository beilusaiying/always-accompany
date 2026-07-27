/**
 * filesPathConfig.mjs — beilu-files 允许/屏蔽路径配置块（权限域共享单源）
 *
 * 功能链：renderFilesPathConfig(container[, cfg]) → getData(plugins:beilu-files) 回填两列表
 *   → 添加/删除 → sendAction verb=addAllowedPath/removeAllowedPath/addBlockedPath/removeBlockedPath
 *   （sendAction.mjs:230 beilu-files 通配桥组装 _action）→ beilu-files main.mjs SetData action 分支
 *   写 pluginData + savePersistedSettings 落盘 → AI 写文件时 isPathAllowed（main.mjs:2153/2186）真强制
 * why：凛倾 2026-07-10「files这个转移到code和work界面，放到权限那边」——路径黑白名单属权限域，
 *   从设置面板（原 settingsSlots.initPluginConfigSlot，已删）迁入 code 权限面板 + work 工具箱·工具权限
 *   双入口；单源共享，禁两处各持一份实现（同 importThemeFile 先例）。
 * 关联链：← permissionPanel.mjs（code 权限档位区）/ workPanel.mjs（work 工具权限区）调用；
 *   → sendAction.mjs（beilu-files getData 精确桥 + #* 通配桥）
 * 影响范围：AI 文件操作路径白/黑名单的编辑入口；后端强制逻辑不在此处、不受影响
 * 使用效果：用户在 code/work 的权限区直接管理 AI 可访问/禁止的路径前缀，改动即时生效并持久化
 *
 * DOM 约束：双面板可能同时在 DOM——一律 data-bf 属性 + container.querySelector 作用域查询，禁全局 id。
 */
import { sendAction } from "../../shared/transport/sendAction.mjs";
import { escapeHtml } from "../../shared/state/utils.mjs";

const _bf = (verb, payload = {}) =>
  sendAction({ verb, target: "plugins:beilu-files", source: "web", payload });

/**
 * 渲染路径配置块到指定容器。
 * @param {HTMLElement} container - 挂载容器（调用方负责外层折叠/标题包装）
 * @param {object} [preloadedCfg] - 调用方已拉取的 beilu-files getData 结果（省一次往返；不传则自拉）
 */
export async function renderFilesPathConfig(container, preloadedCfg) {
  if (!container) return;
  let cfg = preloadedCfg;
  if (!cfg) {
    try {
      cfg = await _bf("getData");
    } catch (e) {
      container.innerHTML = `<p class="text-xs text-error">路径配置加载失败: ${escapeHtml(e?.message || String(e))}</p>`;
      return;
    }
  }

  container.innerHTML = `
    <div class="space-y-1.5 text-xs">
      <div class="text-[10px] opacity-60">允许路径（空 = 不限制）:</div>
      <div data-bf="allowed-list" class="flex flex-wrap gap-1 min-h-[20px]"></div>
      <div class="flex gap-1">
        <input data-bf="allowed-input" class="input input-xs input-bordered flex-1" placeholder="添加允许路径..." />
        <button data-bf="allowed-add" class="btn btn-xs btn-ghost btn-success">＋</button>
      </div>
      <div class="text-[10px] opacity-60 mt-1">屏蔽路径:</div>
      <div data-bf="blocked-list" class="flex flex-wrap gap-1 min-h-[20px]"></div>
      <div class="flex gap-1">
        <input data-bf="blocked-input" class="input input-xs input-bordered flex-1" placeholder="添加屏蔽路径..." />
        <button data-bf="blocked-add" class="btn btn-xs btn-ghost btn-error">＋</button>
      </div>
      <div data-bf="status" class="text-xs text-error hidden"></div>
    </div>
  `;

  const $ = (name) => container.querySelector(`[data-bf="${name}"]`);
  const showErr = (msg) => {
    const st = $("status");
    if (!st) return;
    st.textContent = "❌ " + msg;
    st.classList.remove("hidden");
    setTimeout(() => st.classList.add("hidden"), 4000);
  };

  const renderPaths = (listName, paths, type) => {
    const el = $(listName);
    if (!el) return;
    el.innerHTML = (paths || []).map((p) =>
      `<span class="badge badge-sm gap-1">${escapeHtml(p)}<button class="bf-rm-path text-error cursor-pointer" data-type="${type}" data-path="${escapeHtml(p)}">✕</button></span>`
    ).join("") || '<span class="text-[10px] opacity-40">（空）</span>';
    el.querySelectorAll(".bf-rm-path").forEach((btn) => {
      btn.addEventListener("click", async () => {
        // 不做乐观删除：后端成功才移 DOM，失败保留并提示
        try {
          await _bf(btn.dataset.type === "allowed" ? "removeAllowedPath" : "removeBlockedPath", { path: btn.dataset.path });
          btn.closest(".badge").remove();
        } catch (e) {
          showErr("删除路径失败: " + (e?.message || e));
        }
      });
    });
  };
  renderPaths("allowed-list", cfg?.allowedPaths, "allowed");
  renderPaths("blocked-list", cfg?.blockedPaths, "blocked");

  const addPath = async (type) => {
    const input = $(type + "-input");
    const path = (input?.value || "").trim();
    if (!path) return;
    try {
      await _bf(type === "allowed" ? "addAllowedPath" : "addBlockedPath", { path });
    } catch (e) {
      showErr("添加路径失败: " + (e?.message || e));
      return;
    }
    input.value = "";
    try {
      const d = await _bf("getData");
      renderPaths(type + "-list", type === "allowed" ? d?.allowedPaths : d?.blockedPaths, type);
    } catch { /* 复读失败不覆盖现有列表 */ }
  };
  $("allowed-add")?.addEventListener("click", () => addPath("allowed"));
  $("blocked-add")?.addEventListener("click", () => addPath("blocked"));
  $("allowed-input")?.addEventListener("keydown", (e) => { if (e.key === "Enter") addPath("allowed"); });
  $("blocked-input")?.addEventListener("keydown", (e) => { if (e.key === "Enter") addPath("blocked"); });
}

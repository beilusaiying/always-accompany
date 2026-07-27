/**
 * worldbookEditor.mjs
 * 左栏世界书绑定（原浮窗编辑器文件，浮窗已 0706 凛倾授权整删，见文件尾注）
 *
 * 提供：
 *   - initWorldBinding(deps) — 初始化左栏世界书绑定下拉框 + 额外世界书多选启用（renderExtraWorldbooks）
 *
 * 功能链：index.mjs 初始化/角色可见时调用 → sendAction getData/bind_worldbook/toggle_worldbook/switch_worldbook
 *   → beilu-worldbook per-user store → 生成链 GetPrompt 双开关筛选注入。
 * 世界书条目编辑统一走编辑界面 Tab2 内联（settings/panels.mjs _loadWorldbookInline，含导入/导出/重命名/删除）。
 *
 * deps 参数：{ showToast, escapeHtml, getCurrentCharId, getPartList, worldName }
 */

import { wbDetect } from "../../shared/widgets/whitebox.mjs";
import { sendAction } from "../../shared/transport/sendAction.mjs"; // T6b：出向统一门面（getData GET/字段写 verb=后端字段名→body {[verb]:payload}）
import { beiluConfirm, beiluPrompt } from "../../shared/widgets/beiluDialog.mjs";

// ============================================================
// 世界书绑定（左栏）— 从 beilu-worldbook 插件获取
// ============================================================

/**
 * 渲染额外世界书列表（多选启用/禁用）
 */
async function renderExtraWorldbooks(primaryWb = "", currentCharId = "", deps) {
  const { showToast, escapeHtml } = deps;
  const extraWorldbookList = document.getElementById("extra-worldbook-list");
  if (!extraWorldbookList) return;

  extraWorldbookList.innerHTML =
    '<p class="text-[10px] text-base-content/50 text-center py-1">加载中...</p>';

  try {
    // 门面 getData（GET getdata）：返回世界书配置对象；!ok 由 apiFetch 抛错走 catch。
    const data = await sendAction({ verb: "getData", target: "plugins:beilu-worldbook", source: "web" });

    const wbList = data.worldbook_list || [];
    const wbDetails = data.worldbook_details || {};
    // ★ 双开关机制：额外世界书列表显示所有非主世界书（全局互通）
    const extraList = wbList.filter((name) => name !== primaryWb);

    if (extraList.length === 0) {
      extraWorldbookList.innerHTML =
        '<p class="text-[10px] text-base-content/50 text-center py-1">无额外世界书</p>';
      return;
    }

    extraWorldbookList.innerHTML = "";

    extraList.forEach((name) => {
      const detail = wbDetails[name] || {};
      const enabled = detail.enabled === true;
      const boundCharName = detail.boundCharName || "";
      const entryCount = detail.entry_count || 0;

      const label = document.createElement("label");
      label.className =
        "flex items-center gap-1.5 py-0.5 px-1 rounded cursor-pointer hover:bg-base-300/50";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "checkbox checkbox-xs checkbox-warning";
      checkbox.checked = enabled;

      const nameEl = document.createElement("span");
      nameEl.className = "flex-1 truncate";
      nameEl.textContent = name;

      const metaEl = document.createElement("span");
      metaEl.className = "text-[10px] text-base-content/50 shrink-0";
      const bindText = boundCharName
        ? boundCharName === currentCharId
          ? "[当前角色]"
          : `[${boundCharName}]`
        : "";
      metaEl.textContent = `${entryCount}条${bindText}`;

      checkbox.addEventListener("change", async () => {
        try {
          // verb=toggle_worldbook → 字段写路由组装 body {toggle_worldbook:{...}}。!ok 由 apiFetch 抛错走 catch（回滚 checkbox）。
          await sendAction({ verb: "toggle_worldbook", target: "plugins:beilu-worldbook", source: "web", payload: { name, enabled: checkbox.checked } });
          showToast(
            `世界书 "${name}" 已${checkbox.checked ? "启用" : "禁用"}`,
            "info",
          );
        } catch (err) {
          checkbox.checked = !checkbox.checked;
          showToast("切换世界书失败: " + err.message, "error");
        }
      });

      label.appendChild(checkbox);
      label.appendChild(nameEl);
      label.appendChild(metaEl);
      extraWorldbookList.appendChild(label);
    });
  } catch (err) {
    console.warn("[beilu-chat] renderExtraWorldbooks 失败:", err);
    extraWorldbookList.innerHTML =
      '<p class="text-[10px] text-error text-center py-1">额外世界书加载失败</p>';
  }
}

/**
 * 初始化世界书绑定下拉框
 * @param {object} deps - { showToast, escapeHtml, getCurrentCharId, getPartList, worldName }
 */
export async function initWorldBinding(deps) {
  const { showToast, escapeHtml, getCurrentCharId, getPartList, worldName } =
    deps;
  const leftWorldSelect = document.getElementById("left-world-select");
  const leftWorldStatus = document.getElementById("left-world-status");

  if (!leftWorldSelect) return;

  try {
    // 门面 getData（GET getdata）：返回世界书配置对象；!ok 由 apiFetch 抛错走 catch。
    const data = await sendAction({ verb: "getData", target: "plugins:beilu-worldbook", source: "web" });

    const wbList = data.worldbook_list || [];
    const wbDetails = data.worldbook_details || {};
    const activeWb = data.active_worldbook || "";

    // 填充下拉框
    leftWorldSelect.innerHTML = '<option value="">(无世界书)</option>';
    wbList.forEach((name) => {
      const opt = document.createElement("option");
      opt.value = name;
      const detail = wbDetails[name];
      const suffix = detail?.boundCharName ? ` [${detail.boundCharName}]` : "";
      opt.textContent = name + suffix;
      leftWorldSelect.appendChild(opt);
    });

    // 查找当前角色卡绑定的世界书
    const charId = getCurrentCharId();
    let boundWb = "";
    if (charId) {
      for (const [name, detail] of Object.entries(wbDetails)) {
        if (detail.boundCharName === charId) {
          boundWb = name;
          break;
        }
      }
    }

    const currentWb = boundWb || activeWb;
    leftWorldSelect.value = currentWb || "";
    if (leftWorldStatus) leftWorldStatus.textContent = currentWb || "未绑定";

    // 初始渲染额外世界书
    await renderExtraWorldbooks(currentWb || "", charId || "", deps);

    // ★ Phase 3: 去副作用化 — 只读取和展示，不主动改写后端状态
    if (boundWb) {
      console.log(
        `[beilu-chat] 角色 "${charId}" 绑定的世界书: "${boundWb}" (enabled=${wbDetails[boundWb]?.enabled})`,
      );
    }

    // 选择变化时：绑定角色卡 + 激活世界书
    leftWorldSelect.addEventListener("change", async () => {
      const newName = leftWorldSelect.value || "";
      const charName = getCurrentCharId() || "";

      try {
        if (newName) {
          await sendAction({ verb: "switch_worldbook", target: "plugins:beilu-worldbook", source: "web", payload: { name: newName } });
          if (charName) {
            await sendAction({ verb: "bind_worldbook", target: "plugins:beilu-worldbook", source: "web", payload: { name: newName, charName } });
          }
          if (leftWorldStatus) leftWorldStatus.textContent = newName;
          showToast(
            `世界书 "${newName}" 已激活${charName ? "并绑定到 " + charName : ""}`,
            "success",
          );
        } else {
          if (charName) {
            for (const [name, detail] of Object.entries(wbDetails)) {
              if (detail.boundCharName === charName) {
                await sendAction({ verb: "bind_worldbook", target: "plugins:beilu-worldbook", source: "web", payload: { name, charName: "" } });
              }
            }
          }
          if (leftWorldStatus) leftWorldStatus.textContent = "未绑定";
          showToast("世界书已取消绑定", "info");
        }

        await renderExtraWorldbooks(newName, charName, deps);
      } catch (err) {
        showToast("设置世界书失败: " + err.message, "error");
        leftWorldSelect.value = currentWb || "";
        await renderExtraWorldbooks(currentWb || "", charName, deps);
      }
    });
  } catch (err) {
    console.warn("[beilu-chat] initWorldBinding 失败:", err);
    // 回退：如果 beilu-worldbook 插件不可用，尝试原生方式
    const extraWorldbookList = document.getElementById("extra-worldbook-list");
    try {
      const worlds = await getPartList("worlds");
      leftWorldSelect.innerHTML = '<option value="">(无世界书)</option>';
      worlds.forEach((name) => {
        const opt = document.createElement("option");
        opt.value = name;
        opt.textContent = name;
        leftWorldSelect.appendChild(opt);
      });
      leftWorldSelect.value = worldName || "";
      if (leftWorldStatus) leftWorldStatus.textContent = worldName || "未绑定";
      if (extraWorldbookList) {
        extraWorldbookList.innerHTML =
          '<p class="text-[10px] text-base-content/50 text-center py-1">插件模式不可用</p>';
      }
    } catch (e) {
      // T021 弹出：原占位文案"无额外世界书"把加载失败伪装成正常空态（装饰盖错误）
      // 本文件 showToast 为 deps 注入，契约=(message, type)——核验抓到初版参顺序反转，已修
      showToast("世界书列表加载失败: " + (e?.message || e), "error");
      if (extraWorldbookList) {
        extraWorldbookList.innerHTML =
          '<p class="text-[10px] text-error/70 text-center py-1">世界书列表加载失败</p>';
      }
    }
  }
}

// 死浮窗删除（凛倾 2026-07-06 授权）：原 :225-925 世界书浮窗编辑器（_initWbEditorDrag/openWbEditor/
//   saveWbEntry/initWbEditor 等 17 函数 ~700 行）整块删——浮窗 DOM 早已从 index.html 删净、initWbEditor
//   在 index.mjs 已停调、全库零消费者（双侧穷尽 0706 审计确证）；世界书编辑统一走编辑界面 Tab2 内联
//   （settings/panels.mjs _loadWorldbookInline）。本文件仅存活区：renderExtraWorldbooks + initWorldBinding
//   （左栏世界书绑定下拉，index.mjs 仍消费）。删除前全文有本地备份存档（删除批_20260706_1258）。


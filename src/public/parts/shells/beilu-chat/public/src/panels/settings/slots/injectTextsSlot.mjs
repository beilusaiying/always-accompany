// injectTextsSlot.mjs — 设置面板·AI注入文本配置 slot（0710 铁律收口专项 UI，自 settingsSlots.mjs 拆出，2026-08-03，内容逐字搬迁）
import { escapeHtml } from "../../../shared/state/utils.mjs";
import { sendAction } from "../../../shared/transport/sendAction.mjs";

// ============================================================
// AI 注入文本配置 slot（0710 铁律【代码禁产生进对话文本】收口专项）
//   why：browser/web/sysinfo/toggle/files/memory/bots 各 producer 注入 messages 的引导句/占位符
//        此前硬编码，收口为 functions:injectTexts 单源目录+覆盖层后，用户需要一个编辑面（本 slot）。
//   契约（后端 injectTexts/main.mjs）：getData→{entries:[{key,module,label,placeholders,default,override,effective}]}；
//        setData {overrides:{key:string|null}}，null=删覆盖恢复默认，空串=显式清空（合法，不 trim）。
//   形态：按 module 分组 <details> 折叠（操作界面三原则：不拥挤），textarea 显示生效值，
//        「默认」按钮回填出厂值；保存时 值===默认 → 发 null（收敛覆盖层，不落冗余键）。
//   落位/范式同 initSysinfoConfigSlot；走 sendAction 桥（functions:injectTexts，无旧 REST）。
// ============================================================
export async function initInjectTextsSlot() {
  const anchor = document.getElementById("settings-plugin-config");
  if (!anchor || !anchor.parentElement) return;
  if (document.getElementById("settings-injecttexts-slot")) return;

  const slot = document.createElement("div");
  slot.id = "settings-injecttexts-slot";
  anchor.parentElement.appendChild(slot);

  let entries = [];
  try {
    const data = await sendAction({ verb: "getData", target: "functions:injectTexts", source: "web" });
    entries = data?.entries ?? [];
  } catch (e) {
    slot.innerHTML = `<p class="text-xs text-error mt-2">AI 注入文本配置加载失败: ${escapeHtml(e.message)}</p>`;
    return;
  }

  // 按 module 分组（保持后端目录顺序）
  const groups = new Map();
  for (const en of entries) {
    if (!groups.has(en.module)) groups.set(en.module, []);
    groups.get(en.module).push(en);
  }

  const rowsFor = (text) => Math.min(6, Math.max(2, String(text ?? "").split("\n").length));
  const groupHtml = [...groups.entries()].map(([mod, list]) => `
    <details class="collapse collapse-arrow bg-base-100/50 rounded-lg">
      <summary class="collapse-title text-xs font-medium py-2 min-h-0">${escapeHtml(mod)}<span class="opacity-40 ml-1">(${list.length})</span></summary>
      <div class="collapse-content space-y-2">
        ${list.map((en) => `
          <div>
            <div class="flex items-center justify-between">
              <span class="text-xs">${escapeHtml(en.label)}${en.override !== undefined ? ' <span class="badge badge-xs badge-warning">已改</span>' : ''}</span>
              <span class="flex items-center gap-1">
                ${en.placeholders?.length ? `<span class="text-[10px] opacity-40 font-mono">${escapeHtml(en.placeholders.map((p) => `{${p}}`).join(" "))}</span>` : ""}
                <button class="itx-reset btn btn-xs btn-ghost" data-key="${escapeHtml(en.key)}" title="回填出厂默认值">默认</button>
              </span>
            </div>
            <textarea class="itx-value textarea textarea-bordered textarea-xs w-full font-mono leading-snug" rows="${rowsFor(en.effective)}"
              data-key="${escapeHtml(en.key)}">${escapeHtml(en.effective)}</textarea>
          </div>`).join("")}
      </div>
    </details>`).join("");

  slot.innerHTML = `
    <div class="space-y-2 mt-3 p-3 bg-base-200/50 rounded-lg">
      <h4 class="text-sm font-bold"><i data-ic="edit"></i> AI 注入文本</h4>
      <p class="text-xs text-base-content/40">各功能注入进对话的引导句/占位文本，改后即时生效；「默认」回填出厂值。花括号变量运行时填充。</p>
      ${groupHtml}
      <button id="itx-save" class="btn btn-xs btn-primary w-full"><i data-ic="save"></i> 保存注入文本</button>
      <div id="itx-status" class="text-xs text-center hidden"></div>
    </div>
  `;

  const defaults = Object.fromEntries(entries.map((en) => [en.key, en.default]));
  const showStatus = (msg, type = "info") => {
    const st = slot.querySelector("#itx-status");
    st.textContent = msg;
    st.className = `text-xs text-center ${type === "success" ? "text-success" : type === "error" ? "text-error" : "text-warning"}`;
    st.classList.remove("hidden");
    if (type === "success") setTimeout(() => st.classList.add("hidden"), 2000);
  };

  slot.querySelectorAll(".itx-reset").forEach((btn) => {
    btn.addEventListener("click", () => {
      const ta = slot.querySelector(`.itx-value[data-key="${CSS.escape(btn.dataset.key)}"]`);
      if (ta) ta.value = defaults[btn.dataset.key] ?? "";
    });
  });

  slot.querySelector("#itx-save").addEventListener("click", async () => {
    try {
      // 不 trim：注入文本的空白/换行有语义（如多行引导块）；值===默认 → null 收敛覆盖层
      const overrides = {};
      slot.querySelectorAll(".itx-value").forEach((ta) => {
        const key = ta.dataset.key;
        overrides[key] = ta.value === defaults[key] ? null : ta.value;
      });
      const res = await sendAction({ verb: "setData", target: "functions:injectTexts", source: "web", payload: { overrides } });
      if (res?.rejected?.length) showStatus(`⚠️ 部分键被拒: ${res.rejected.join(", ")}`, "error");
      else showStatus("✅ 已保存", "success");
    } catch (e) {
      showStatus("❌ " + e.message, "error");
    }
  });
}

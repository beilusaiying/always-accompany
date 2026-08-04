// toggleSlot.mjs — 设置面板·AI条目控制(toggle)手动控制面（自 settingsSlots.mjs 拆出，2026-08-03，内容逐字搬迁）
import { sendAction } from "../../../shared/transport/sendAction.mjs";

// ============================================================
// ============================================================
// [2026-08-01 W6] toggle 手动控制面
// ============================================================

export async function initToggleSlot() {
  const anchor = document.getElementById("settings-plugin-config");
  if (!anchor || !anchor.parentElement) return;
  if (document.getElementById("settings-toggle-slot")) return;

  const slot = document.createElement("div");
  slot.id = "settings-toggle-slot";
  slot.className = "mt-4";
  anchor.parentElement.appendChild(slot);

  slot.innerHTML = `
    <div class="collapse collapse-arrow bg-base-200/30 rounded-lg">
      <input type="checkbox" />
      <div class="collapse-title text-sm font-medium min-h-0 py-2 px-3"><i data-ic="shuffle"></i> AI 条目控制</div>
      <div class="collapse-content px-3 pb-3 text-xs space-y-2">
        <p class="opacity-50">AI 通过 &lt;toggle&gt; 标签动态启/禁预设条目。此面板可手动翻转或查看 AI 历史操作。</p>
        <div id="toggle-entry-list" class="space-y-1"></div>
        <div class="flex gap-2 mt-2">
          <button id="toggle-refresh" class="btn btn-xs btn-outline btn-info">刷新</button>
          <button id="toggle-clear-all" class="btn btn-xs btn-outline btn-warning">清除所有覆盖</button>
        </div>
        <div id="toggle-history" class="mt-2"></div>
      </div>
    </div>
  `;

  async function loadToggle() {
    const listEl = slot.querySelector("#toggle-entry-list");
    const histEl = slot.querySelector("#toggle-history");
    if (!listEl) return;
    try {
      // 获取当前覆盖状态
      const tgData = await sendAction({ verb: "getData", target: "plugins:beilu-toggle", source: "web" });
      const overrides = tgData?.overrides || {};
      const history = tgData?.history || [];

      // 从 preset 获取可控条目列表（toggleable_entries）
      let entries = [];
      try {
        const presetData = await sendAction({ verb: "getData", target: "plugins:beilu-preset", source: "web" });
        entries = presetData?.toggleable_entries || [];
      } catch {}

      if (entries.length === 0) {
        listEl.innerHTML = '<p class="opacity-40">当前预设无可控条目</p>';
      } else {
        listEl.innerHTML = entries.map(e => {
          const overridden = overrides[e.identifier] !== undefined;
          const currentEnabled = overridden ? overrides[e.identifier] : e.enabled;
          return `<div class="flex items-center gap-2 px-2 py-1 rounded ${overridden ? 'bg-warning/10' : 'bg-base-200/40'}">
            <input type="checkbox" class="toggle toggle-xs toggle-success toggle-entry-cb" data-identifier="${e.identifier}" ${currentEnabled ? 'checked' : ''} />
            <span class="flex-1 truncate">${e.name || e.identifier}</span>
            ${overridden ? '<span class="badge badge-xs badge-warning">已覆盖</span>' : ''}
          </div>`;
        }).join("");

        listEl.querySelectorAll(".toggle-entry-cb").forEach(cb => {
          cb.addEventListener("change", async () => {
            try {
              await sendAction({ verb: "setData", target: "plugins:beilu-toggle", source: "web",
                payload: { manual_toggle: { identifier: cb.dataset.identifier, enabled: cb.checked } } });
              loadToggle();
            } catch (err) { console.error("[toggle] 手动翻转失败:", err); }
          });
        });
      }

      // 历史
      if (history.length > 0) {
        histEl.innerHTML = '<p class="text-[10px] opacity-40 mb-1">最近操作</p>' +
          history.slice(-5).reverse().map(h => {
            const t = h.time ? new Date(h.time).toLocaleTimeString() : '?';
            return `<div class="text-[10px] opacity-50">${t} · ${h.source === 'ai' ? 'AI' : '手动'} · ${h.identifier} → ${h.enabled ? '启用' : '禁用'}</div>`;
          }).join("");
      } else {
        histEl.innerHTML = '';
      }
    } catch (err) { listEl.innerHTML = `<p class="text-error text-xs">${err.message}</p>`; }
  }

  slot.querySelector("#toggle-refresh")?.addEventListener("click", loadToggle);
  slot.querySelector("#toggle-clear-all")?.addEventListener("click", async () => {
    try {
      await sendAction({ verb: "setData", target: "plugins:beilu-toggle", source: "web", payload: { clear_overrides: true } });
      loadToggle();
    } catch (err) { console.error("[toggle] 清除覆盖失败:", err); }
  });

  loadToggle();
}

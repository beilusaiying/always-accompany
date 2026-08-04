// sysinfoSlot.mjs — 设置面板·beilu-sysinfo 系统信息注入配置 slot（自 settingsSlots.mjs 拆出，2026-08-03，内容逐字搬迁）
import { escapeHtml } from "../../../shared/state/utils.mjs";
import { sendAction } from "../../../shared/transport/sendAction.mjs";

// ============================================================
// beilu-sysinfo 系统信息注入配置 slot（孤儿verb期2·用户设置类）
//   why：功能链 GetData→includeTime/includeOS/includeMemory/refreshInterval + customFields 后端有字段
//        （functions/prompt/sysinfo/main.mjs:105-114 pluginData + :134-144 GetData + :174-179 字段直写 SetData），
//        前端零编辑入口=孤儿。sysinfo 默认 enabled:true 已在用，注入内容开关为用户中频控制项。
//   契约（亲读 sysinfo/main.mjs:145-180）：混合分发——布尔/数值字段无 _action 直写（本 slot 保存走此路）；
//        自定义字段增删走 _action addCustomField/removeCustomField（field:{key,value} / index）。
//        customFields 也支持整体字段直写（:178），故本 slot 直接整表回写 customFields（不逐条 _action，减少往返）。
//   敏感性：sysinfo 无凭据字段，全明文可见。落位锚 settings-plugin-config 同级追加，范式镜像 initStripTagsSlot。
export async function initSysinfoConfigSlot() {
  const anchor = document.getElementById("settings-plugin-config");
  if (!anchor || !anchor.parentElement) return;
  if (document.getElementById("settings-sysinfo-slot")) return;

  // T2批1收口：SI_API 常量 + postSi raw 封装已删（getdata/setdata 均改走 sendAction 门面）。
  const slot = document.createElement("div");
  slot.id = "settings-sysinfo-slot";
  anchor.parentElement.appendChild(slot);

  let cfg = {};
  try {
    // T2批1收口：raw GET → sendAction 门面（plugins:beilu-sysinfo#getData REST 精确路由，回包=解析体裸体等价）
    cfg = await sendAction({ verb: "getData", target: "plugins:beilu-sysinfo", source: "web" }) || {};
  } catch (e) {
    slot.innerHTML = `<p class="text-xs text-error mt-2">beilu-sysinfo 配置加载失败: ${escapeHtml(e.message)}</p>`;
    return;
  }

  // customFields 本地态（回填自后端；增删改后整表 direct-write）
  let customFields = Array.isArray(cfg.customFields) ? cfg.customFields.map(f => ({ key: f.key || "", value: f.value || "" })) : [];

  slot.innerHTML = `
    <div class="space-y-3 mt-3 p-3 bg-base-200/50 rounded-lg">
      <h4 class="text-sm font-bold"><i data-ic="info"></i> beilu-sysinfo 系统信息注入</h4>
      <p class="text-xs text-base-content/40">注入给 AI 的运行环境上下文（时间/系统/内存/自定义）</p>
      <div class="space-y-2">
        <!-- [0722 差集补入口] enabled 总开关：后端可配（sysinfo SetData 接受）此前无 toggle -->
        <label class="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" id="si-enabled" class="toggle toggle-xs toggle-warning" ${cfg.enabled !== false ? 'checked' : ''} />
          <span class="text-xs">启用系统信息注入（总开关）</span>
        </label>
        <label class="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" id="si-time" class="toggle toggle-xs toggle-success" ${cfg.includeTime ? 'checked' : ''} />
          <span class="text-xs">注入时间信息</span>
        </label>
        <label class="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" id="si-os" class="toggle toggle-xs toggle-success" ${cfg.includeOS ? 'checked' : ''} />
          <span class="text-xs">注入系统/主机信息</span>
        </label>
        <label class="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" id="si-mem" class="toggle toggle-xs toggle-info" ${cfg.includeMemory ? 'checked' : ''} />
          <span class="text-xs">注入内存占用</span>
        </label>
      </div>
      <label class="flex items-center justify-between gap-2">
        <span class="text-xs">刷新间隔（秒，0=每次刷新）</span>
        <input type="number" id="si-refresh" min="0" step="1" class="input input-xs input-bordered w-24" value="${cfg.refreshInterval ?? ''}" />
      </label>
      <!-- 自定义字段 -->
      <div>
        <span class="text-xs font-medium">自定义字段</span>
        <div id="si-custom-list" class="space-y-1 mt-1"></div>
        <div class="flex gap-1 mt-1">
          <input id="si-new-key" class="input input-xs input-bordered flex-1" placeholder="键" />
          <input id="si-new-val" class="input input-xs input-bordered flex-1" placeholder="值" />
          <button id="si-add-field" class="btn btn-xs btn-ghost btn-success">＋</button>
        </div>
      </div>
      <button id="si-save" class="btn btn-xs btn-primary w-full"><i data-ic="save"></i> 保存配置</button>
      <div id="si-status" class="text-xs text-center hidden"></div>
    </div>
  `;

  const $ = (id) => slot.querySelector("#" + id);
  const showStatus = (msg, type = "info") => {
    const st = $("si-status");
    st.textContent = msg;
    st.className = `text-xs text-center ${type === "success" ? "text-success" : type === "error" ? "text-error" : "text-warning"}`;
    st.classList.remove("hidden");
    if (type === "success") setTimeout(() => st.classList.add("hidden"), 2000);
  };

  const renderCustom = () => {
    const el = $("si-custom-list");
    el.innerHTML = customFields.map((f, i) =>
      `<div class="flex items-center gap-1">
        <span class="badge badge-sm flex-1 justify-start gap-1 font-mono overflow-hidden"><span class="truncate">${escapeHtml(f.key)}</span>=<span class="truncate opacity-70">${escapeHtml(f.value)}</span></span>
        <button class="si-rm-field btn btn-xs btn-ghost btn-error" data-i="${i}">✕</button>
      </div>`
    ).join("");
    el.querySelectorAll(".si-rm-field").forEach(btn => {
      btn.addEventListener("click", () => {
        customFields.splice(Number(btn.dataset.i), 1);
        renderCustom();
      });
    });
  };
  renderCustom();

  $("si-add-field").addEventListener("click", () => {
    const k = $("si-new-key").value.trim();
    const v = $("si-new-val").value.trim();
    if (!k) return;
    customFields.push({ key: k, value: v });
    $("si-new-key").value = "";
    $("si-new-val").value = "";
    renderCustom();
  });

  $("si-save").addEventListener("click", async () => {
    try {
      // 字段直写（无 _action）→ 后端 sysinfo/main.mjs:174-179。customFields 整表回写（:178 支持）。
      const body = {
        enabled: $("si-enabled").checked, // [0722 差集补入口] 总开关随表提交
        includeTime: $("si-time").checked,
        includeOS: $("si-os").checked,
        includeMemory: $("si-mem").checked,
        customFields,
      };
      const ri = $("si-refresh").value.trim();
      if (ri !== "") body.refreshInterval = Number(ri);
      // T2批1收口：postSi raw POST 封装 → sendAction 门面（updateSysinfoConfig REST 字段直写含 customFields 整表，if(!res.ok)throw 由门面接管删除）
      await sendAction({ verb: "updateSysinfoConfig", target: "plugins:beilu-sysinfo", source: "web", payload: body });
      showStatus("✅ 已保存", "success");
    } catch (e) {
      showStatus("❌ " + e.message, "error");
    }
  });
}

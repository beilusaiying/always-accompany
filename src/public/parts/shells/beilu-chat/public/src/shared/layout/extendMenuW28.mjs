/**
 * extendMenuW28.mjs — 顶栏 ≡ 扩展菜单弹出/关闭 + 模型选择器同步（W28）
 *
 * 功能链：
 *   initExtendMenuW28() → #extend-menu-btn 点击 → toggle #extend-menu-popup（隐藏/显示）
 *   → 点击外部 document click → 收起菜单
 *   → 菜单项 [data-menu-action] 点击 → handleMenuAction(action)
 *   → #model-selector-btn 点击 → 展开 #model-selector-dropdown
 *   → 右侧栏 #api-model-select / #api-model input 变化 → syncModelLabel() → 同步顶栏模型标签
 *
 * [0716 散写收口·生效绑定视图] 模型选择器双作用域：
 *   子模式作用域（work/code + 同组活跃子模式带绑定，window._beiluResolveSubModeBinding 判定，
 *     判据与后端生成真值同源）→ 标签显示子模式绑定模型/源默认；下拉列表从绑定源拉
 *     （window._beiluGetModelList）；选择写回活跃子模式（window._beiluWriteSubModeModel，
 *     与子模式触发栏模型弹窗同写点）——凛倾 0716「work和code都是子模式为主，对话这里要跟着子模式走」。
 *   全局作用域（chat/smart/bot/跨组/无绑定）→ 原行为：镜像 #api-model/#api-model-select。
 *   刷新时机：子模式域变化=subModePanel._updateTriggerBar 单点发 beilu:effectiveModelChanged；
 *   本窗视角变化（切模式 tab / 切对话）=消费方自听 beilu:mode-switched + hashchange。
 *   why 不直写 #api-model：全局选择器值会被 apiConfig handleSave 持久化进 AI源 config=子模式模型永久污染全局。
 *
 * why：
 *   顶栏 ≡ 菜单是低频全局操作入口（导出/设置/帮助等），独立模块避免污染主逻辑；
 *   模型选择器在顶栏显示当前模型名，需与右侧栏 #api-model-select 保持同步（单向：右栏→顶栏）；
 *   [T06 已废弃] AIRP 侧栏链接和联网搜索开关已移除，相关 DOM 不存在，querySelector 返回空集合静默跳过。
 *
 * 关联链：
 *   ← layout.mjs / index.mjs（initExtendMenuW28 调用）
 *   → shared/transport/api-client.mjs（apiFetch：菜单操作如导出等）
 *   → shared/state/sharedState.mjs（getChatId：菜单操作需当前对话 ID）
 *   → shared/state/storage.mjs（KEYS：菜单相关 localStorage 读写）
 *
 * 影响范围：
 *   DOM：#extend-menu-popup 显示/隐藏；#model-selector-label 文本同步；
 *   无状态持久化（菜单展开状态不写 localStorage），无后端主动请求（handleMenuAction 视 action 而定）。
 *
 * 使用效果：
 *   点 ≡ 弹菜单，点外部收起；顶栏模型标签实时反映右侧栏选择的模型名称。
 */

import { sendAction } from "../transport/sendAction.mjs"; // T6b：出向统一门面
import { showToast } from "../../../../../../scripts/toast.mjs"; // 0716 轮子收口：原走 _beiluPublicShowToast 二级窗口桥（该桥已删，toast.mjs 单源直连）
import { getChatId } from "../state/sharedState.mjs";
import { downloadBlob } from "../state/utils.mjs"; // 0716 下载基元收口
import { storage, KEYS } from "../state/storage.mjs";
import { MODEL_SOURCE_DEFAULT_LABEL } from "../state/modeTabMap.mjs"; // 源默认模型选项文案单源（与子模式触发栏弹窗同源 [0716]）

export function initExtendMenuW28() {
  // [T06已废弃] AIRP侧栏链接事件（airp-only-section DOM已移除，querySelector返回空集合）

  const menuBtn = document.getElementById("extend-menu-btn");
  const menuPopup = document.getElementById("extend-menu-popup");
  const modelBtn = document.getElementById("model-selector-btn");
  const modelLabel = document.getElementById("model-selector-label");

  if (!menuBtn || !menuPopup) return;

  function _positionPopup() {
    const rect = menuBtn.getBoundingClientRect();
    menuPopup.style.left = rect.left + "px";
    menuPopup.style.bottom = (window.innerHeight - rect.top + 6) + "px";
    menuPopup.style.top = "";
    if (menuPopup.getBoundingClientRect().top < 8) {
      menuPopup.style.bottom = "";
      menuPopup.style.top = (rect.bottom + 6) + "px";
    }
  }

  // ≡菜单 toggle
  menuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    menuPopup.classList.toggle("hidden");
    if (!menuPopup.classList.contains("hidden")) _positionPopup();
  });

  // 点击外部关闭
  document.addEventListener("click", (e) => {
    if (!menuPopup.contains(e.target) && e.target !== menuBtn) {
      menuPopup.classList.add("hidden");
    }
  });

  // 菜单项事件
  menuPopup.querySelectorAll("[data-menu-action]").forEach((item) => {
    item.addEventListener("click", () => {
      const action = item.dataset.menuAction;
      handleMenuAction(action);
      menuPopup.classList.add("hidden");
    });
  });

  // [T06已废弃] 联网搜索开关持久化（≡菜单的web-search-toggle已移除，右栏toggle-web-search为唯一入口）

  // 模型选择器: 同步右侧栏API模型（全局作用域）+ 生效绑定视图刷新（子模式作用域）
  syncModelLabel();
  const apiModelSelect = document.getElementById("api-model-select");
  const apiModelInput = document.getElementById("api-model");
  if (apiModelSelect) {
    apiModelSelect.addEventListener("change", syncModelLabel);
  }
  if (apiModelInput) {
    apiModelInput.addEventListener("change", syncModelLabel);
    apiModelInput.addEventListener("input", syncModelLabel);
  }
  // 子模式域变化（切换/绑定改/init 数据就位/配置广播重拉）→ subModePanel._updateTriggerBar 单点通知
  window.addEventListener("beilu:effectiveModelChanged", syncModelLabel);
  // 本窗视角变化：切模式 tab（work→chat 绑定视图要退回全局）/ 切对话（活跃子模式 per-chatId）
  window.addEventListener("beilu:mode-switched", syncModelLabel);
  window.addEventListener("hashchange", syncModelLabel);
  // [0727 多窗口] 切窗口=纯显示交换：模型标签跟着可见窗口的子模式绑定走
  //   （_beiluResolveSubModeBinding → subModePanel，其"当前对话"读点已窗口化，纯缓存解析零请求）
  window.addEventListener("beilu:window-switched", syncModelLabel);

  /** 当前生效子模式绑定（null=全局作用域）。每次现场解析不缓存——多窗口并行下本窗模式/对话随时变 */
  function _subModeBinding() {
    try { return window._beiluResolveSubModeBinding ? window._beiluResolveSubModeBinding() : null; } catch { return null; }
  }

  // 模型选择器点击: 弹出模型下拉列表
  const modelDropdown = document.getElementById("model-selector-dropdown");
  if (modelBtn && modelDropdown) {
    let _fillReqId = 0; // 竞态令牌：异步拉列表期间被关闭/重开则丢弃（同 subModePanel._modelPopupReqId 范式）
    modelBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!modelDropdown.classList.contains("hidden")) {
        modelDropdown.classList.add("hidden");
        return;
      }
      const reqId = ++_fillReqId;
      modelDropdown.innerHTML = "";
      modelDropdown.classList.remove("hidden");
      const btnRect = modelBtn.getBoundingClientRect();
      modelDropdown.style.bottom = (window.innerHeight - btnRect.top + 4) + "px";
      modelDropdown.style.right = (window.innerWidth - btnRect.right) + "px";

      const binding = _subModeBinding();
      if (binding) {
        // 子模式作用域：列表从绑定源拉（源空=全局激活源，与生成语义一致：model_override 打在全局源上），
        // 选择写回活跃子模式——禁走 _beiluSetModel（那是全局层，work/code 下写它=所见非所用+污染源 config）
        const loading = document.createElement("div");
        loading.className = "model-option-empty";
        loading.textContent = "加载模型列表...";
        modelDropdown.appendChild(loading);
        let names = [];
        if (binding.source) {
          let models = [];
          // [0717] force：下拉点击=每次实时访问源，不吃 30s TTL（凛倾「每次点击都需要访问」）
          try { models = window._beiluGetModelList ? await window._beiluGetModelList(binding.source, { force: true }) : []; } catch { models = []; }
          names = models.map((m) => (typeof m === "string" ? m : (m && (m.id || m.name)) || "")).filter(Boolean);
        } else {
          // 绑模型未绑源：生成=全局激活源+model_override（getCachedModelList("")=[] 不可用）→ 列表镜像全局源
          const gSel = document.getElementById("api-model-select");
          if (gSel) for (let i = 0; i < gSel.options.length; i++) { if (gSel.options[i].value) names.push(gSel.options[i].value); }
        }
        if (reqId !== _fillReqId || modelDropdown.classList.contains("hidden")) return;
        modelDropdown.innerHTML = "";
        if (!names.length) {
          const hint = document.createElement("div");
          hint.className = "model-option-empty";
          hint.textContent = binding.source ? "该 API 源暂无模型列表（可用源默认）" : "请先在API设置中获取模型列表";
          modelDropdown.appendChild(hint);
        }
        // 首项=清除模型绑定回源默认（与子模式触发栏模型弹窗同语义）
        const entries = [{ value: "", label: MODEL_SOURCE_DEFAULT_LABEL }].concat(names.map((n) => ({ value: n, label: n })));
        for (const opt of entries) {
          const item = document.createElement("div");
          item.className = "model-option" + (opt.value === (binding.model || "") ? " active" : "");
          item.textContent = opt.label;
          item.addEventListener("click", async () => {
            modelDropdown.classList.add("hidden");
            try {
              const ok = window._beiluWriteSubModeModel ? await window._beiluWriteSubModeModel(opt.value) : false;
              if (!ok) showToast("error", "子模式模型写回失败", 3000);
            } catch (err) {
              showToast("error", "子模式模型写回失败: " + err.message, 3000);
            }
            syncModelLabel();
          });
          modelDropdown.appendChild(item);
        }
        return;
      }

      // 全局作用域：[0717] 原纯镜像右侧栏 #api-model-select 快照 → 点击=实时访问当前编辑源
      //   （凛倾「拉条是每次都需要访问,不是访问一次就缓存,每次点击都需要访问」）。
      //   实时拉失败/无源名时回退镜像快照（诚实降级，不空转）。选择写点不变（_beiluSetModel 全局层）。
      const gSrc = document.getElementById("api-select")?.value || "";
      let gNames = [];
      if (gSrc) {
        const gLoading = document.createElement("div");
        gLoading.className = "model-option-empty";
        gLoading.textContent = "加载模型列表...";
        modelDropdown.appendChild(gLoading);
        try { gNames = window._beiluGetModelList ? await window._beiluGetModelList(gSrc, { force: true }) : []; } catch { gNames = []; }
        if (reqId !== _fillReqId || modelDropdown.classList.contains("hidden")) return;
        modelDropdown.innerHTML = "";
      }
      if (!gNames.length) {
        // 回退：镜像右侧栏快照（原行为）
        const modelSelect = document.getElementById("api-model-select");
        if (modelSelect) for (let i = 0; i < modelSelect.options.length; i++) { if (modelSelect.options[i].value) gNames.push(modelSelect.options[i].value); }
      }
      if (gNames.length > 0) {
        const currentModel = document.getElementById("api-model")?.value || "";
        for (const name of gNames) {
          const item = document.createElement("div");
          item.className = "model-option" + (name === currentModel ? " active" : "");
          item.textContent = name;
          item.addEventListener("click", () => {
            var _setM = window._beiluSetModel;
            if (_setM) _setM(name);
            else { var _mi = document.getElementById("api-model"); if (_mi) { _mi.value = name; _mi.dispatchEvent(new Event("change")); } }
            modelDropdown.classList.add("hidden");
            syncModelLabel();
          });
          modelDropdown.appendChild(item);
        }
      } else {
        const empty = document.createElement("div");
        empty.className = "model-option-empty";
        empty.textContent = "请先在API设置中获取模型列表";
        modelDropdown.appendChild(empty);
      }
    });
    // 点击外部关闭
    document.addEventListener("click", (e) => {
      if (!modelDropdown.contains(e.target) && e.target !== modelBtn) {
        modelDropdown.classList.add("hidden");
      }
    });
    // ESC 关闭走中央仲裁注册表（priority 38，与子模式弹出层 40 同层级）
    const reg = (window._beiluEscRegistry = window._beiluEscRegistry || []);
    if (!reg.some((r) => r._id === "model-dropdown")) {
      reg.push({
        _id: "model-dropdown",
        priority: 38,
        isOpen: () => !modelDropdown.classList.contains("hidden"),
        close: () => modelDropdown.classList.add("hidden"),
      });
    }
  }

  function syncModelLabel() {
    if (!modelLabel) return;
    // 子模式作用域：显示生效绑定（所见即生成实际用的），不读全局 #api-model
    const binding = _subModeBinding();
    if (binding) {
      if (binding.model) {
        modelLabel.textContent = binding.model.split("/").pop().split(":")[0];
        modelLabel.title = "子模式「" + binding.label + "」绑定模型: " + binding.model + (binding.source ? "（源: " + binding.source + "）" : "");
      } else {
        // 只绑源未绑模型=生成用该源默认模型（源 config.model），前端无该值单源读点，如实显示语义
        modelLabel.textContent = binding.source + "·源默认";
        modelLabel.title = "子模式「" + binding.label + "」绑定源 " + binding.source + "（使用源默认模型）";
      }
      return;
    }
    const modelInput = document.getElementById("api-model");
    const modelName = modelInput?.value?.trim();
    if (modelName) {
      // 取最后一段作为简短显示
      const short = modelName.split("/").pop().split(":")[0];
      modelLabel.textContent = short;
      modelLabel.title = modelName;
    } else {
      modelLabel.textContent = "配置API→";
    }
  }
}

function handleMenuAction(action) {
  switch (action) {
    case "export-md":
      exportChatAsMD();
      break;
    case "prompt-viewer":
      window.dispatchEvent(new CustomEvent("beilu:openPromptViewer"));
      break;
    case "new-chat":
      window.dispatchEvent(new CustomEvent("beilu:newChat"));
      break;
    case "manage-chats":
      window.dispatchEvent(new CustomEvent("beilu:manageChats"));
      break;
    case "regenerate":
      window.dispatchEvent(new CustomEvent("beilu:regenerate"));
      break;
    case "batch-delete":
      window.dispatchEvent(new CustomEvent("beilu:batchDelete"));
      break;
    case "display-settings":
      openDisplaySettingsPanel();
      break;
  }
}

async function exportChatAsMD() {
  try {
    // T6b：raw+手 lenRes.ok/len 语义并入门面（!ok → 抛错→外层 catch 显示错误；原"获取对话长度失败" 分支合并进门面 target#verb 定位报错）
    const cid = getChatId();
    const len = await sendAction({ verb: "getLogLength", target: "shells:chat", source: "web", scope: { chatId: cid } });
    if (!len || len <= 0) { showToast("warning", "当前对话为空", 2000); return; }

    const messages = await sendAction({ verb: "getLog", target: "shells:chat", source: "web", scope: { chatId: cid }, payload: { start: 0, end: len } });
    if (!Array.isArray(messages) || messages.length === 0) { showToast("warning", "对话为空", 2000); return; }

    const charName = window._beiluGetCharId?.() || "角色";
    const now = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    let md = `# 对话导出 — ${charName}\n\n> 导出时间: ${new Date().toLocaleString()}\n> 消息数: ${messages.length}\n\n---\n\n`;

    for (const msg of messages) {
      if (!msg || msg.is_system) continue;
      const role = msg.role === "user" ? "👤 用户" : (msg.role === "assistant" || msg.role === "char") ? `🤖 ${msg.name || charName}` : `📋 ${msg.role || "系统"}`;
      const content = (msg.content || "").trim();
      if (!content) continue;
      md += `## ${role}\n\n${content}\n\n---\n\n`;
    }

    // 0716 轮子收口：内联 <a download> → utils.downloadBlob 基元
    downloadBlob(new Blob([md], { type: "text/markdown;charset=utf-8" }), `对话_${charName}_${now}.md`);
    showToast("success", `已导出 ${messages.length} 条消息`, 2000);
  } catch (e) {
    console.error("[extendMenu] 导出MD失败:", e);
    showToast("error", "导出失败: " + e.message, 3000);
  }
}

async function openDisplaySettingsPanel() {
  if (document.getElementById("display-settings-popup")) return;

  const overlay = document.createElement("div");
  overlay.id = "display-settings-popup";
  overlay.style.cssText = "position:fixed;inset:0;z-index:var(--z-overlay);display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.5)";
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });

  const panel = document.createElement("div");
  panel.style.cssText = "background:oklch(var(--b1));border:1px solid oklch(var(--b3));border-radius:12px;padding:20px;max-width:360px;width:90%;max-height:80vh;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,0.3)";
  panel.innerHTML = '<div class="flex items-center justify-between mb-3"><h3 class="text-sm font-bold">显示设置</h3><button id="ds-close" class="btn btn-xs btn-ghost">✕</button></div><div id="ds-body">加载中...</div>';
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  const reg = (window._beiluEscRegistry = window._beiluEscRegistry || []);
  if (!reg.some((r) => r._id === "display-settings-popup")) {
    reg.push({
      _id: "display-settings-popup",
      priority: 42,
      isOpen: () => !!document.getElementById("display-settings-popup"),
      close: () => document.getElementById("display-settings-popup")?.remove(),
    });
  }
  panel.querySelector("#ds-close").addEventListener("click", () => overlay.remove());

  try {
    // 思维链设定（折叠开关/内置标签/自定义标签对）已收口到 设置→AI服务源「思维链显示」（凛倾 2026-07-14），
    // 本浮窗只剩非思维链的显示项：正则处理器开关。
    const regexEnabled = storage.get(KEYS.BEILU_REGEX_ENABLED) !== "false";

    const body = panel.querySelector("#ds-body");
    body.innerHTML = `
      <div class="flex flex-col gap-3">
        <label class="flex items-center justify-between">
          <span class="text-xs"><i data-ic="abc"></i> 正则处理器</span>
          <input type="checkbox" class="toggle toggle-xs" id="ds-regex" ${regexEnabled ? "checked" : ""} />
        </label>
        <button class="btn btn-xs btn-primary w-fit" id="ds-save"><i data-ic="save"></i> 保存</button>
      </div>`;

    body.querySelector("#ds-save").addEventListener("click", () => {
      const btn = body.querySelector("#ds-save");
      // 正则开关：0713 A1 收口 featureControls setter 唯一写点（setter 自身幂等：无变化不重渲染）。
      // window 桥=层向约束（shared 不 import panels）。
      window._beiluSetRegexEnabled(body.querySelector("#ds-regex")?.checked ?? true);
      btn.innerHTML = '<i data-ic="check"></i> 已保存';
      setTimeout(() => overlay.remove(), 800);
    });
  } catch (e) {
    panel.querySelector("#ds-body").textContent = "加载失败: " + e.message;
  }
}

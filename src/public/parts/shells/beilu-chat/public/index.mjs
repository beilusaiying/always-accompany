/**
 * beilu-chat 前端入口脚本
 *
 * 融合两部分功能：
 * 1. Fount chat shell 聊天功能（消息发送/接收/流式渲染）
 * 2. beilu 管理面板（预设管理、模型参数等）
 */
import { initTranslations } from "../../scripts/i18n.mjs";
import { getPartDetails, getPartList } from "../../scripts/parts.mjs";
import { usingTemplates } from "../../scripts/template.mjs";
import { applyTheme } from "../../scripts/theme.mjs";

import { initApiConfig, loadApiConfig } from "./src/apiConfig.mjs";
import {
  charList,
  initializeChat,
  personaName,
  setPersonaName,
  worldName,
} from "./src/chat.mjs";
import { bindDataTableToChar, initDataTable } from "./src/dataTable.mjs";
import {
  addUserReply,
  currentChatId,
  deleteMessage,
  modifyTimeLine,
  setPersona,
  triggerCharacterReply,
} from "./src/endpoints.mjs";
import { initFileExplorer } from "./src/fileExplorer.mjs";
import { initLayout } from "./src/layout.mjs";
import {
  bindMemoryBrowserToChar,
  initMemoryBrowser,
} from "./src/memoryBrowser.mjs";
import { initMemoryPresetChat } from "./src/memoryPresetChat.mjs";
import { initPromptViewer, openPromptViewer } from "./src/promptViewer.mjs";
import { initRegexEditor } from "./src/regexEditor.mjs";
import { initSTCompat } from "./src/ui/stCompat/index.mjs";
import { initPluginManager } from "./src/ui/stCompat/pluginManager.mjs";
import { initScriptManager } from "./src/ui/stCompat/scriptManager.mjs";
import { loadCharacterScripts } from "./src/ui/stCompat/scriptRunner.mjs";
import { initVariableManager } from "./src/ui/stCompat/variableManager.mjs";
import { updateContext as updateVarContext } from "./src/ui/stCompat/variableStore.mjs";
import {
  getChatLogIndexByQueueIndex,
  getQueue,
} from "./src/ui/virtualQueue.mjs";

// ============================================================
// beilu 管理面板 — API 通信层
// ============================================================

const PRESET_API_GET = "/api/parts/plugins:beilu-preset/config/getdata";
const PRESET_API_SET = "/api/parts/plugins:beilu-preset/config/setdata";
const REGEX_API_SET = "/api/parts/plugins:beilu-regex/config/setdata";

/**
 * 获取预设插件配置数据
 * @returns {Promise<any>}
 */
async function getPresetData() {
  const res = await fetch(PRESET_API_GET);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * 设置预设插件配置数据
 * @param {any} data - 要设置的数据（直接作为请求体）
 * @returns {Promise<any>}
 */
async function setPresetData(data) {
  const res = await fetch(PRESET_API_SET, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// ============================================================
// 预设正则联动 — 同步预设中的 regex_scripts 到 beilu-regex
// ============================================================

/**
 * 将预设 JSON 中的正则脚本同步到 beilu-regex 插件
 * 调用 syncPresetRegex action：先清除该预设旧的正则，再导入新正则
 * @param {string} presetName - 预设名称
 * @param {object} presetJson - 完整预设 JSON（含 extensions.regex_scripts）
 */
async function syncPresetRegexToPlugin(presetName, presetJson) {
  const scripts = presetJson?.extensions?.regex_scripts;
  if (!scripts || !Array.isArray(scripts) || scripts.length === 0) {
    console.log(`[beilu-chat] 预设 "${presetName}" 无正则脚本，跳过同步`);
    return;
  }
  try {
    const resp = await fetch(REGEX_API_SET, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        _action: "syncPresetRegex",
        presetName,
        scripts,
      }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const result = await resp.json();
    const r = result?._result || result;
    console.log(
      `[beilu-chat] 预设 "${presetName}" 正则同步完成: 移除 ${r.removed || 0} 条, 导入 ${r.imported || 0} 条`,
    );
  } catch (err) {
    console.warn(
      `[beilu-chat] 预设 "${presetName}" 正则同步失败:`,
      err.message,
    );
  }
}

/**
 * 从 beilu-regex 插件移除指定预设的所有正则规则
 * @param {string} presetName - 预设名称
 */
async function removePresetRegexFromPlugin(presetName) {
  try {
    const resp = await fetch(REGEX_API_SET, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        _action: "removeByPreset",
        presetName,
      }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const result = await resp.json();
    const r = result?._result || result;
    console.log(
      `[beilu-chat] 预设 "${presetName}" 正则已清理: 移除 ${r.removed || 0} 条`,
    );
  } catch (err) {
    console.warn(
      `[beilu-chat] 清理预设 "${presetName}" 正则失败:`,
      err.message,
    );
  }
}

// ============================================================
// beilu 管理面板 — DOM 引用
// ============================================================

// 右栏 — API 设置
const apiFetchModelsBtn = document.getElementById("api-fetch-models");
const apiModelSelect = document.getElementById("api-model-select");

// 左栏 — 预设选择器
const presetSelector = document.getElementById("preset-selector");
const presetCreateBtn = document.getElementById("preset-create-btn");
const presetDeleteBtn = document.getElementById("preset-delete-btn");

// 预设面板
const presetName = document.getElementById("preset-name");
const presetImportBtn = document.getElementById("preset-import-btn");
const presetExportBtn = document.getElementById("preset-export-btn");
const presetFileInput = document.getElementById("preset-file-input");
const presetStats = document.getElementById("preset-stats");
const presetStatTotal = document.getElementById("preset-stat-total");
const presetStatEnabled = document.getElementById("preset-stat-enabled");
const presetStatSystem = document.getElementById("preset-stat-system");
const presetStatInject = document.getElementById("preset-stat-inject");
const entrySearch = document.getElementById("entry-search");
const entryList = document.getElementById("entry-list");

// 条目详情
const entryDetail = document.getElementById("entry-detail");
const detailName = document.getElementById("detail-name");
const detailToggle = document.getElementById("detail-toggle");
const detailRole = document.getElementById("detail-role");
const detailType = document.getElementById("detail-type");
const detailDepthRow = document.getElementById("detail-depth-row");
const detailDepth = document.getElementById("detail-depth");
const detailContent = document.getElementById("detail-content");
const detailEditBtn = document.getElementById("detail-edit-btn");
const detailSaveBtn = document.getElementById("detail-save-btn");
const detailCancelBtn = document.getElementById("detail-cancel-btn");

// 模型参数
const paramTemp = document.getElementById("param-temp");
const paramTempValue = document.getElementById("param-temp-value");
const paramTopP = document.getElementById("param-top-p");
const paramTopPValue = document.getElementById("param-top-p-value");
const paramTopK = document.getElementById("param-top-k");
const paramTopKValue = document.getElementById("param-top-k-value");
const paramMinP = document.getElementById("param-min-p");
const paramMinPValue = document.getElementById("param-min-p-value");
const paramMaxContext = document.getElementById("param-max-context");
const paramMaxTokens = document.getElementById("param-max-tokens");
const modelParamsSave = document.getElementById("model-params-save");
const modelParamsStatus = document.getElementById("model-params-status");

// ============================================================
// beilu 管理面板 — 状态
// ============================================================

let currentEntries = [];
let selectedEntryId = null;
let currentPresetJson = null;
let isEditing = false;
/** identifier → 完整 content 映射（从 preset_json.prompts 提取） */
let contentMap = {};

// ============================================================
// 模型获取逻辑 (移植自 proxy/display.mjs)
// ============================================================

const normalizeUrl = (url) => {
  let urlObj;
  try {
    urlObj = new URL(url);
  } catch {
    if (!url.startsWith("http"))
      try {
        urlObj = new URL("https://" + url);
      } catch {
        try {
          urlObj = new URL("http://" + url);
        } catch {
          return null;
        }
      }
    else return null;
  }
  if (urlObj.pathname.includes("/chat/completions"))
    urlObj.pathname = urlObj.pathname.replace(
      /\/chat\/completions.*$/,
      "/models",
    );
  else {
    let path = urlObj.pathname;

    if (path.endsWith("/")) path = path.slice(0, -1);

    if (path.endsWith("/v1")) urlObj.pathname = path + "/models";
    else urlObj.pathname = path + "/v1/models";
  }

  return urlObj.toString();
};

async function fetchModels() {
  const apiUrlInput = document.getElementById("api-url");
  const apiKeyInput = document.getElementById("api-key");
  const url = apiUrlInput?.value;
  const apikey = apiKeyInput?.value;
  const btn = apiFetchModelsBtn;
  const select = apiModelSelect;

  if (!url) {
    showToast("请先填写 API URL", "error");
    return;
  }

  const modelsUrl = normalizeUrl(url);
  if (!modelsUrl) {
    showToast("无效的 API URL", "error");
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.classList.add("loading");
  }
  showToast("正在获取模型列表...", "info");

  try {
    let models = [];

    // 1. 尝试直接请求
    try {
      const response = await fetch(modelsUrl, {
        headers: { Authorization: apikey ? "Bearer " + apikey : undefined },
      });
      if (response.ok) {
        const result = await response.json();
        models = result.data || result;
      } else {
        throw new Error(`Direct fetch failed: ${response.status}`);
      }
    } catch (directError) {
      console.warn(
        "[beilu-chat] Direct fetch failed, trying proxy...",
        directError,
      );

      // 2. 尝试通过 beilu-memory 代理请求
      try {
        const proxyResp = await fetch(
          "/api/parts/plugins:beilu-memory/config/setdata",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              _action: "getModels",
              apiConfig: { url: url, key: apikey },
            }),
          },
        );
        if (proxyResp.ok) {
          const proxyResult = await proxyResp.json();
          if (proxyResult.success && Array.isArray(proxyResult.models)) {
            models = proxyResult.models.map((id) => ({ id }));
          } else {
            throw new Error(proxyResult.error || "Proxy returned invalid data");
          }
        } else {
          throw new Error(`Proxy fetch failed: ${proxyResp.status}`);
        }
      } catch (proxyError) {
        console.error("[beilu-chat] Proxy fetch also failed:", proxyError);
        throw new Error(`获取模型失败: ${directError.message}`);
      }
    }

    if (!Array.isArray(models)) throw new Error("返回数据格式错误");

    const modelIds = models.map((m) => m.id).sort();

    // 更新下拉框
    if (select) {
      select.innerHTML =
        '<option value="" disabled selected>选择模型...</option>';
      modelIds.forEach((id) => {
        const opt = document.createElement("option");
        opt.value = id;
        opt.textContent = id;
        select.appendChild(opt);
      });
      select.classList.remove("hidden");
    }

    showToast(`✅ 获取成功，共 ${modelIds.length} 个模型`, "success");
  } catch (err) {
    console.error("[beilu-chat] 获取模型失败:", err);
    showToast("❌ " + err.message, "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.classList.remove("loading");
    }
  }
}

// ============================================================
// 预设管理
// ============================================================

/**
 * 将后端返回的预设数据应用到 UI
 * @param {object} data - getPresetData() 的返回值
 */
/** 预设描述缓存（从 GetData 获取） */
let presetDescriptions = {};

function applyPresetData(data) {
  // 缓存预设描述
  if (data.preset_descriptions) {
    presetDescriptions = data.preset_descriptions;
  }

  // 填充预设选择器下拉框
  if (presetSelector && data.preset_list) {
    const prevValue = presetSelector.value;
    presetSelector.innerHTML = "";
    if (data.preset_list.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "(无预设)";
      presetSelector.appendChild(opt);
    } else {
      data.preset_list.forEach((name) => {
        const opt = document.createElement("option");
        opt.value = name;
        opt.textContent = name;
        presetSelector.appendChild(opt);
      });
    }
    presetSelector.value = data.active_preset || prevValue || "";
  }

  presetName.textContent = data.preset_name || "未加载";
  currentPresetJson = data.preset_json || null;
  currentEntries = data.entries || [];

  // 从完整 preset_json 构建 identifier → content 映射
  contentMap = {};
  if (currentPresetJson?.prompts) {
    for (const p of currentPresetJson.prompts) {
      if (p.identifier) contentMap[p.identifier] = p.content || "";
    }
  }

  renderEntryList(currentEntries);
  updateStats(currentEntries);
  if (data.model_params) syncModelParamsUI(data.model_params);
}

async function loadPresetData() {
  try {
    const data = await getPresetData();
    applyPresetData(data);
  } catch (err) {
    console.error("[beilu-chat] 加载预设数据失败:", err);
    presetName.textContent = "加载失败";
  }
}

function renderEntryList(entries, filter = "") {
  entryList.innerHTML = "";
  if (!entries || entries.length === 0) {
    entryList.innerHTML =
      '<p class="text-sm text-base-content/50 text-center py-4">请先导入一个 ST 预设文件</p>';
    return;
  }
  const filtered = filter
    ? entries.filter((e) =>
        e.name?.toLowerCase().includes(filter.toLowerCase()),
      )
    : entries;
  if (filtered.length === 0) {
    entryList.innerHTML =
      '<p class="text-sm text-base-content/50 text-center py-2">无匹配条目</p>';
    return;
  }
  filtered.forEach((entry) => {
    const item = document.createElement("div");
    item.className = `preset-entry ${entry.enabled ? "" : "opacity-50"} ${entry.identifier === selectedEntryId ? "ring-1 ring-amber-500" : ""}`;
    item.dataset.id = entry.identifier;
    // v14.3: 类型标签基于 system_prompt + injection_position
    // system_prompt: true → 系统（内置4条）
    // injection_position: 0 → 相对位置（系统区域）
    // injection_position: 1 → 注入 @D{深度}
    const injPos = entry.injection_position ?? 0;
    let typeLabel, typeBadgeClass;
    if (entry.system_prompt) {
      typeLabel = "系统";
      typeBadgeClass = "badge-info";
    } else if (injPos === 1) {
      typeLabel = `D${entry.injection_depth ?? "?"}`;
      typeBadgeClass = "badge-ghost";
    } else {
      typeLabel = "相对";
      typeBadgeClass = "badge-info";
    }
    const roleBadge =
      entry.role === "system"
        ? "🔧"
        : entry.role === "user"
          ? "👤"
          : entry.role === "assistant"
            ? "🤖"
            : "📝";
    item.innerHTML = `
			<div class="flex items-center gap-2 w-full">
				<input type="checkbox" class="checkbox checkbox-xs checkbox-warning entry-toggle"
					data-id="${entry.identifier}" ${entry.enabled ? "checked" : ""} />
				<span class="text-xs opacity-50">${roleBadge}</span>
				<span class="flex-1 text-sm truncate entry-name">${escapeHtml(entry.name || "(无名)")}</span>
				<span class="badge badge-xs ${typeBadgeClass}">${typeLabel}</span>
			</div>
		`;
    item.addEventListener("click", (e) => {
      if (e.target.classList.contains("entry-toggle")) return;
      selectEntry(entry);
    });
    entryList.appendChild(item);
  });
  entryList.querySelectorAll(".entry-toggle").forEach((cb) => {
    cb.addEventListener("change", async (e) => {
      e.stopPropagation();
      await toggleEntry(cb.dataset.id, cb.checked);
    });
  });
}

entrySearch?.addEventListener("input", () => {
  renderEntryList(currentEntries, entrySearch.value);
});

function updateStats(entries) {
  if (!entries || entries.length === 0) {
    presetStats.classList.add("hidden");
    return;
  }
  presetStats.classList.remove("hidden");
  presetStatTotal.textContent = entries.length;
  presetStatEnabled.textContent = entries.filter((e) => e.enabled).length;
  // v14.3: 统计基于 injection_position
  // 系统区 = system_prompt:true 或 injection_position:0
  // 注入 = injection_position:1
  presetStatSystem.textContent = entries.filter(
    (e) => e.system_prompt || (e.injection_position ?? 0) === 0,
  ).length;
  presetStatInject.textContent = entries.filter(
    (e) => !e.system_prompt && (e.injection_position ?? 0) === 1,
  ).length;
}

function selectEntry(entry) {
  selectedEntryId = entry.identifier;
  exitEditMode();
  entryList.querySelectorAll(".preset-entry").forEach((el) => {
    el.classList.toggle("ring-1", el.dataset.id === entry.identifier);
    el.classList.toggle("ring-amber-500", el.dataset.id === entry.identifier);
  });
  detailName.textContent = entry.name || "(无名)";
  detailToggle.checked = entry.enabled;

  // 角色选择框
  detailRole.value = entry.role || "system";

  // 类型选择框 — v14.3: 基于 injection_position
  const injPos = entry.injection_position ?? 0;
  if (entry.system_prompt) {
    detailType.value = "system_prompt";
  } else if (injPos === 1) {
    detailType.value = "injection";
  } else {
    detailType.value = "system_prompt"; // 相对位置归入系统区
  }

  // 注入深度：仅 injection_position === 1 时显示
  if (injPos === 1 && !entry.system_prompt) {
    detailDepthRow.classList.remove("hidden");
    detailDepth.value = entry.injection_depth ?? 0;
  } else {
    detailDepthRow.classList.add("hidden");
  }

  // 从 contentMap 获取完整内容（而非截断的 content_preview）
  const fullContent =
    contentMap[entry.identifier] ?? entry.content_preview ?? "";
  detailContent.value = fullContent;
  entryDetail.classList.remove("hidden");

  // 确保字段默认不可编辑
  setFieldsEditable(false);
}

function setFieldsEditable(editable) {
  if (detailRole) detailRole.disabled = !editable;
  if (detailType) detailType.disabled = !editable;
  if (detailDepth) detailDepth.disabled = !editable;
}

detailToggle?.addEventListener("change", async () => {
  if (!selectedEntryId) return;
  await toggleEntry(selectedEntryId, detailToggle.checked);
});

// 类型切换时联动深度显示
detailType?.addEventListener("change", () => {
  if (detailType.value === "system_prompt") {
    detailDepthRow.classList.add("hidden");
  } else {
    detailDepthRow.classList.remove("hidden");
  }
});

detailEditBtn?.addEventListener("click", () => {
  isEditing = true;
  detailContent.readOnly = false;
  detailContent.classList.add("textarea-warning");
  setFieldsEditable(true);
  detailEditBtn.classList.add("hidden");
  detailSaveBtn.classList.remove("hidden");
  detailCancelBtn.classList.remove("hidden");
});

detailCancelBtn?.addEventListener("click", () => {
  exitEditMode();
  const entry = currentEntries.find((e) => e.identifier === selectedEntryId);
  if (entry) {
    // 从 contentMap 恢复完整内容
    detailContent.value =
      contentMap[selectedEntryId] ?? entry.content_preview ?? "";
    selectEntry(entry);
  }
});

detailSaveBtn?.addEventListener("click", async () => {
  if (!selectedEntryId) return;
  try {
    const updateData = {
      identifier: selectedEntryId,
      content: detailContent.value,
    };

    // 收集字段变更
    const props = {};
    const newRole = detailRole.value;
    if (newRole) props.role = newRole;

    const newType = detailType.value;
    const isNowSystemPrompt = newType === "system_prompt";
    props.system_prompt = isNowSystemPrompt;

    if (!isNowSystemPrompt) {
      const depthVal = parseInt(detailDepth.value);
      if (!isNaN(depthVal)) props.injection_depth = depthVal;
    }

    if (Object.keys(props).length > 0) {
      updateData.props = props;
    }

    await setPresetData({ update_entry: updateData });

    // 同步更新 contentMap
    contentMap[selectedEntryId] = detailContent.value;

    exitEditMode();
    showToast("条目已保存", "success");
    // 重新加载以刷新条目列表中的标签
    await loadPresetData();
  } catch (err) {
    showToast("保存失败: " + err.message, "error");
  }
});

function exitEditMode() {
  isEditing = false;
  if (detailContent) {
    detailContent.readOnly = true;
    detailContent.classList.remove("textarea-warning");
  }
  setFieldsEditable(false);
  if (detailEditBtn) detailEditBtn.classList.remove("hidden");
  if (detailSaveBtn) detailSaveBtn.classList.add("hidden");
  if (detailCancelBtn) detailCancelBtn.classList.add("hidden");
}

async function toggleEntry(identifier, enabled) {
  try {
    await setPresetData({ toggle_entry: { identifier, enabled } });
    const entry = currentEntries.find((e) => e.identifier === identifier);
    if (entry) entry.enabled = enabled;
    renderEntryList(currentEntries, entrySearch?.value || "");
    updateStats(currentEntries);
  } catch (err) {
    showToast("切换失败: " + err.message, "error");
    loadPresetData();
  }
}

// 导入
presetImportBtn?.addEventListener("click", () => presetFileInput?.click());
presetFileInput?.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const json = JSON.parse(text);
    const presetName_ = file.name.replace(/\.json$/i, "");

    // 首次导入（不强制覆盖）
    const result = await setPresetData({
      import_preset: { json, name: presetName_ },
    });

    // 检查重名
    if (result.duplicate) {
      const overwrite = confirm(
        `预设 "${presetName_}" 已存在，是否覆盖？\n选择"取消"将跳过导入。`,
      );
      if (overwrite) {
        await setPresetData({
          import_preset: { json, name: presetName_, force_overwrite: true },
        });
        showToast(`预设 "${presetName_}" 已覆盖导入`, "success");
      } else {
        showToast("导入已取消", "info");
        presetFileInput.value = "";
        return;
      }
    } else {
      showToast(`预设 "${file.name}" 导入成功`, "success");
    }

    // 同步预设中的正则脚本到 beilu-regex 插件
    await syncPresetRegexToPlugin(presetName_, json);

    await loadPresetData();
  } catch (err) {
    showToast("导入失败: " + err.message, "error");
  }
  presetFileInput.value = "";
});

// 预设选择器 — 切换预设
presetSelector?.addEventListener("change", async () => {
  const name = presetSelector.value;
  if (!name) return;
  try {
    await setPresetData({ switch_preset: { name } });
    showToast(`已切换到预设: "${name}"`, "success");
    await loadPresetData();
  } catch (err) {
    showToast("切换预设失败: " + err.message, "error");
  }
});

// 新建预设
presetCreateBtn?.addEventListener("click", async () => {
  const name = prompt("请输入新预设名称:");
  if (!name?.trim()) return;
  try {
    await setPresetData({ create_preset: { name: name.trim() } });
    showToast(`预设 "${name.trim()}" 已创建`, "success");
    await loadPresetData();
  } catch (err) {
    showToast("创建失败: " + err.message, "error");
  }
});

// 删除预设
presetDeleteBtn?.addEventListener("click", async () => {
  const name = presetSelector?.value;
  if (!name) {
    showToast("没有选中的预设", "warning");
    return;
  }
  if (!confirm(`确定删除预设 "${name}" 吗？此操作不可撤销。`)) return;
  try {
    await setPresetData({ delete_preset: { name } });
    // 清理该预设在 beilu-regex 中绑定的正则规则
    await removePresetRegexFromPlugin(name);
    showToast(`预设 "${name}" 已删除`, "success");
    await loadPresetData();
  } catch (err) {
    showToast("删除失败: " + err.message, "error");
  }
});

// 导出
presetExportBtn?.addEventListener("click", async () => {
  try {
    const data = await getPresetData();
    const json = data.preset_json;
    if (!json) {
      showToast("没有可导出的预设", "warning");
      return;
    }
    const blob = new Blob([JSON.stringify(json, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${data.preset_name || "preset"}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast("预设已导出", "success");
  } catch (err) {
    showToast("导出失败: " + err.message, "error");
  }
});

// ============================================================
// 模型参数
// ============================================================

paramTemp?.addEventListener("input", () => {
  paramTempValue.textContent = parseFloat(paramTemp.value).toFixed(2);
});
paramTopP?.addEventListener("input", () => {
  paramTopPValue.textContent = parseFloat(paramTopP.value).toFixed(2);
});
paramTopK?.addEventListener("input", () => {
  paramTopKValue.textContent = paramTopK.value;
});
paramMinP?.addEventListener("input", () => {
  paramMinPValue.textContent = parseFloat(paramMinP.value).toFixed(2);
});

function syncModelParamsUI(params) {
  if (!params) return;
  if (params.temperature != null) {
    paramTemp.value = params.temperature;
    paramTempValue.textContent = parseFloat(params.temperature).toFixed(2);
  }
  if (params.top_p != null) {
    paramTopP.value = params.top_p;
    paramTopPValue.textContent = parseFloat(params.top_p).toFixed(2);
  }
  if (params.top_k != null) {
    paramTopK.value = params.top_k;
    paramTopKValue.textContent = params.top_k;
  }
  if (params.min_p != null) {
    paramMinP.value = params.min_p;
    paramMinPValue.textContent = parseFloat(params.min_p).toFixed(2);
  }
  if (params.max_context != null) paramMaxContext.value = params.max_context;
  if (params.max_tokens != null) paramMaxTokens.value = params.max_tokens;
}

async function loadModelParams() {
  try {
    const data = await getPresetData();
    if (data.model_params) syncModelParamsUI(data.model_params);
  } catch (err) {
    console.error("[beilu-chat] 加载模型参数失败:", err);
  }
}

modelParamsSave?.addEventListener("click", async () => {
  const params = {
    temperature: parseFloat(paramTemp.value),
    top_p: parseFloat(paramTopP.value),
    top_k: parseInt(paramTopK.value, 10),
    min_p: parseFloat(paramMinP.value),
    max_context: parseInt(paramMaxContext.value, 10),
    max_tokens: parseInt(paramMaxTokens.value, 10),
  };
  try {
    await setPresetData({ update_model_params: params });
    modelParamsStatus.textContent = "✅ 参数已保存";
    modelParamsStatus.className = "text-xs text-center mt-1 text-success";
    modelParamsStatus.classList.remove("hidden");
    setTimeout(() => modelParamsStatus.classList.add("hidden"), 2000);
  } catch (err) {
    modelParamsStatus.textContent = "❌ 保存失败: " + err.message;
    modelParamsStatus.className = "text-xs text-center mt-1 text-error";
    modelParamsStatus.classList.remove("hidden");
  }
});

// ============================================================
// 记忆 dataTable 编辑器
// ============================================================

/** dataTable 是否已初始化 */
let _dataTableInitialized = false;

// 记忆编辑器 DOM 引用
const memoryDatatableArea = document.getElementById("memory-datatable-area");

/**
 * 获取当前聊天的主角色卡名称
 * @returns {string|null}
 */
function getCurrentCharId() {
  return charList && charList.length > 0 ? charList[0] : null;
}

/**
 * 初始化记忆 dataTable 编辑器
 * 自动绑定到当前聊天的角色卡
 */
function ensureDataTableInit() {
  if (!_dataTableInitialized && memoryDatatableArea) {
    const charId = getCurrentCharId();
    initDataTable(memoryDatatableArea, null, { charId: charId || "" });
    _dataTableInitialized = true;

    // 如果初始化时 charList 还没加载好，延迟重试绑定
    if (!charId) {
      const retryTimer = setInterval(() => {
        const id = getCurrentCharId();
        if (id) {
          clearInterval(retryTimer);
          bindDataTableToChar(id);
          console.log("[beilu-chat] dataTable 延迟绑定角色卡:", id);
        }
      }, 2000);
      // 最多重试 30 秒
      setTimeout(() => clearInterval(retryTimer), 30000);
    }
  } else if (_dataTableInitialized) {
    // 已初始化但角色卡可能变了，检查绑定
    const charId = getCurrentCharId();
    if (charId) bindDataTableToChar(charId);
  }
}

// ============================================================
// 工具函数
// ============================================================

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function showToast(message, type = "info") {
  // 尝试使用 Fount 的 toast
  try {
    import("../../scripts/toast.mjs")
      .then(({ showToast: fountToast }) => {
        fountToast(type, message);
      })
      .catch(() => fallbackToast(message, type));
  } catch {
    fallbackToast(message, type);
  }
}

function fallbackToast(message, type) {
  const toast = document.createElement("div");
  toast.className = `alert alert-${type === "success" ? "success" : type === "error" ? "error" : type === "warning" ? "warning" : "info"} fixed top-4 right-4 z-[100] max-w-sm shadow-lg`;
  toast.innerHTML = `<span>${escapeHtml(message)}</span>`;
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transition = "opacity 0.3s";
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// ============================================================
// 世界书绑定（左栏）— 从 beilu-worldbook 插件获取
// ============================================================

const leftWorldSelect = document.getElementById("left-world-select");
const leftWorldStatus = document.getElementById("left-world-status");

const WB_API_GET = "/api/parts/plugins:beilu-worldbook/config/getdata";
const WB_API_SET = "/api/parts/plugins:beilu-worldbook/config/setdata";

/**
 * 初始化世界书绑定下拉框
 * 从 beilu-worldbook 插件获取世界书列表，填充下拉框
 * 选择时绑定角色卡名称（boundCharName），激活对应世界书
 */
async function initWorldBinding() {
  if (!leftWorldSelect) return;

  try {
    const res = await fetch(WB_API_GET);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

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

    // 设置当前值：优先显示角色卡绑定的世界书，其次显示 active_worldbook
    const currentWb = boundWb || activeWb;
    leftWorldSelect.value = currentWb || "";
    leftWorldStatus.textContent = currentWb || "未绑定";

    // 如果找到角色卡绑定的世界书且不是当前激活的，自动激活
    if (boundWb && boundWb !== activeWb) {
      try {
        await fetch(WB_API_SET, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ switch_worldbook: { name: boundWb } }),
        });
        console.log(
          `[beilu-chat] 自动激活角色 "${charId}" 绑定的世界书: "${boundWb}"`,
        );
      } catch (err) {
        console.warn("[beilu-chat] 自动激活绑定世界书失败:", err.message);
      }
    }

    // 选择变化时：绑定角色卡 + 激活世界书
    leftWorldSelect.addEventListener("change", async () => {
      const newName = leftWorldSelect.value || "";
      const charName = getCurrentCharId() || "";

      try {
        if (newName) {
          // 激活选中的世界书
          await fetch(WB_API_SET, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ switch_worldbook: { name: newName } }),
          });
          // 绑定到当前角色卡
          if (charName) {
            await fetch(WB_API_SET, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                bind_worldbook: { name: newName, charName },
              }),
            });
          }
          leftWorldStatus.textContent = newName;
          showToast(
            `世界书 "${newName}" 已激活${charName ? "并绑定到 " + charName : ""}`,
            "success",
          );
        } else {
          // 取消绑定：解除当前角色绑定的所有世界书
          if (charName) {
            for (const [name, detail] of Object.entries(wbDetails)) {
              if (detail.boundCharName === charName) {
                await fetch(WB_API_SET, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    bind_worldbook: { name, charName: "" },
                  }),
                });
              }
            }
          }
          leftWorldStatus.textContent = "未绑定";
          showToast("世界书已取消绑定", "info");
        }
      } catch (err) {
        showToast("设置世界书失败: " + err.message, "error");
        leftWorldSelect.value = currentWb || "";
      }
    });
  } catch (err) {
    console.warn("[beilu-chat] initWorldBinding 失败:", err);
    // 回退：如果 beilu-worldbook 插件不可用，尝试原生方式
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
      leftWorldStatus.textContent = worldName || "未绑定";
    } catch {
      /* 静默 */
    }
  }
}

// ============================================================
// 用户人设选择（左栏）
// ============================================================

const leftPersonaSelect = document.getElementById("left-persona-select");
const leftPersonaStatus = document.getElementById("left-persona-status");
const leftPersonaDesc = document.getElementById("left-persona-desc");

/**
 * 初始化用户人设选择下拉框
 * 从 Fount parts API 获取 persona 列表，填充下拉框，绑定事件
 */
async function initPersonaSelector() {
  if (!leftPersonaSelect) return;

  try {
    const personas = await getPartList("personas");

    // 填充下拉框
    leftPersonaSelect.innerHTML = '<option value="">(默认)</option>';
    personas.forEach((name) => {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      leftPersonaSelect.appendChild(opt);
    });

    // 设置当前值
    const syncValue = async () => {
      leftPersonaSelect.value = personaName || "";
      leftPersonaStatus.textContent = personaName || "默认";
      // 加载描述
      if (personaName && leftPersonaDesc) {
        try {
          const details = await getPartDetails("personas/" + personaName);
          leftPersonaDesc.textContent = details?.info?.description || "";
        } catch {
          leftPersonaDesc.textContent = "";
        }
      } else if (leftPersonaDesc) {
        leftPersonaDesc.textContent = "";
      }
    };
    await syncValue();

    // 延迟重试
    if (!personaName) {
      const retryTimer = setInterval(async () => {
        if (personaName != null) {
          clearInterval(retryTimer);
          await syncValue();
        }
      }, 2000);
      setTimeout(() => clearInterval(retryTimer), 15000);
    }

    // 选择变化时设置人设
    leftPersonaSelect.addEventListener("change", async () => {
      const newName = leftPersonaSelect.value || null;
      try {
        await setPersona(newName);
        setPersonaName(newName);
        leftPersonaStatus.textContent = newName || "默认";
        // 更新描述
        if (newName && leftPersonaDesc) {
          try {
            const details = await getPartDetails("personas/" + newName);
            leftPersonaDesc.textContent = details?.info?.description || "";
          } catch {
            leftPersonaDesc.textContent = "";
          }
        } else if (leftPersonaDesc) {
          leftPersonaDesc.textContent = "";
        }
        showToast(
          `人设已${newName ? "设为: " + newName : "恢复默认"}`,
          "success",
        );
      } catch (err) {
        showToast("设置人设失败: " + err.message, "error");
        leftPersonaSelect.value = personaName || "";
      }
    });
  } catch (err) {
    console.warn("[beilu-chat] initPersonaSelector 失败:", err);
  }
}

// ============================================================
// 记忆AI手动操作（右栏"记忆AI操作"折叠组）
// ============================================================

const memOpStatus = document.getElementById("mem-op-status");

/**
 * 初始化记忆AI手动操作按钮（P2-P6）
 * 绑定点击事件，调用后端 runMemoryPreset
 */
function initMemoryOps() {
  const buttons = document.querySelectorAll('[id^="mem-op-P"]');
  if (buttons.length === 0) return;

  buttons.forEach((btn) => {
    btn.addEventListener("click", () => handleMemoryOp(btn));
  });
  console.log("[beilu-chat] 记忆AI手动操作按钮已初始化:", buttons.length, "个");
}

/**
 * 处理记忆AI手动操作按钮点击
 * @param {HTMLButtonElement} btn - 被点击的按钮
 */
async function handleMemoryOp(btn) {
  const presetId = btn.dataset.preset;
  if (!presetId) return;

  const charId = getCurrentCharId();
  if (!charId) {
    showToast("请先加载角色卡", "warning");
    return;
  }

  // 禁用所有操作按钮，防止重复点击
  const allBtns = document.querySelectorAll('[id^="mem-op-P"]');
  allBtns.forEach((b) => {
    b.disabled = true;
  });

  // 显示运行状态
  if (memOpStatus) {
    memOpStatus.textContent = `⏳ ${presetId} 运行中...`;
    memOpStatus.className = "text-xs text-center mt-1.5 text-amber-600";
    memOpStatus.classList.remove("hidden");
  }

  // 启动记忆AI输出面板轮询（以便实时看到输出）
  startMemoryOutputPoll();

  try {
    // 收集聊天历史（最近10条）
    let chatHistory = "";
    try {
      const chatMsgs = document.querySelectorAll(
        "#chat-messages .chat-message .message-content",
      );
      const recent = Array.from(chatMsgs).slice(-10);
      chatHistory = recent
        .map((el) => el.textContent?.trim())
        .filter(Boolean)
        .join("\n---\n");
    } catch {
      /* ignore */
    }

    const charName =
      document.getElementById("char-name-display")?.textContent?.trim() ||
      "角色";

    const resp = await fetch("/api/parts/plugins:beilu-memory/config/setdata", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        _action: "runMemoryPreset",
        presetId,
        charDisplayName: charName,
        userDisplayName: "用户",
        chatHistory,
        dryRun: false,
      }),
    });

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const result = await resp.json();

    if (result?.error) {
      if (memOpStatus) {
        memOpStatus.textContent = `❌ ${presetId}: ${result.error}`;
        memOpStatus.className = "text-xs text-center mt-1.5 text-error";
      }
      showToast(`${presetId} 运行失败: ${result.error}`, "error");
    } else {
      if (memOpStatus) {
        memOpStatus.textContent = `✅ ${presetId} 完成`;
        memOpStatus.className = "text-xs text-center mt-1.5 text-success";
      }
      showToast(`${presetId} 运行完成`, "success");
      setTimeout(() => memOpStatus?.classList.add("hidden"), 3000);
    }
  } catch (err) {
    if (memOpStatus) {
      memOpStatus.textContent = `❌ ${presetId}: ${err.message}`;
      memOpStatus.className = "text-xs text-center mt-1.5 text-error";
    }
    showToast(`${presetId} 运行失败: ${err.message}`, "error");
  } finally {
    allBtns.forEach((b) => {
      b.disabled = false;
    });
  }
}

// ============================================================
// 角色快捷信息面板（左栏）
// ============================================================

const charAvatarDisplay = document.getElementById("char-avatar-display");
const charNameDisplay = document.getElementById("char-name-display");
const charDescShort = document.getElementById("char-desc-short");
const charGreetingEdit = document.getElementById("char-greeting-edit");
const charDescriptionEdit = document.getElementById("char-description-edit");
const charInfoEditBtn = document.getElementById("char-info-edit-btn");
const charInfoSaveBtn = document.getElementById("char-info-save-btn");
const charInfoCancelBtn = document.getElementById("char-info-cancel-btn");

/** 原始数据备份（用于取消编辑时还原） */
let _charInfoOriginal = {};

/**
 * 初始化角色信息面板
 * 从 charList[0] 获取主角色信息并填充 UI
 */
async function initCharInfoPanel() {
  const charId = getCurrentCharId();
  if (!charId) {
    // charList 可能还没加载，延迟重试
    const retryTimer = setInterval(async () => {
      const id = getCurrentCharId();
      if (id) {
        clearInterval(retryTimer);
        await loadCharInfo(id);
      }
    }, 2000);
    setTimeout(() => clearInterval(retryTimer), 30000);
    return;
  }
  await loadCharInfo(charId);
}

/**
 * 加载指定角色卡的信息到面板 UI
 * @param {string} charId - 角色卡 ID（目录名）
 */
async function loadCharInfo(charId) {
  try {
    const details = await getPartDetails("chars/" + charId);
    if (!details?.info) return;

    const info = details.info;

    // 头像
    if (charAvatarDisplay) {
      if (info.avatar) {
        charAvatarDisplay.innerHTML = `<img src="${escapeHtml(info.avatar)}" class="w-full h-full object-cover" alt="avatar" />`;
      } else {
        charAvatarDisplay.textContent = "🎭";
      }
    }

    // 名字
    if (charNameDisplay) {
      charNameDisplay.textContent = info.name || charId;
      charNameDisplay.dataset.charId = charId;
    }
    const headerCharName = document.getElementById("header-char-name");
    if (headerCharName) headerCharName.textContent = info.name || charId;

    // 短描述
    if (charDescShort) charDescShort.textContent = info.description || "";

    // 角色描述（完整 markdown）
    if (charDescriptionEdit)
      charDescriptionEdit.value =
        info.description_markdown || info.description || "";

    // 开场白 — 延迟从聊天队列获取第一条角色消息
    if (charGreetingEdit) {
      charGreetingEdit.value = "(加载中...)";
      setTimeout(() => {
        try {
          const queue = getQueue();
          const firstCharMsg = queue.find((m) => m.role === "char");
          charGreetingEdit.value =
            firstCharMsg?.content || "(开场白由角色代码定义)";
        } catch {
          charGreetingEdit.value = "(开场白由角色代码定义)";
        }
      }, 3000);
    }

    _charInfoOriginal = {
      description_markdown: info.description_markdown || "",
    };
  } catch (err) {
    console.warn("[beilu-chat] 加载角色信息失败:", err);
  }
}

// 编辑按钮
charInfoEditBtn?.addEventListener("click", () => {
  if (charGreetingEdit) {
    charGreetingEdit.readOnly = false;
    charGreetingEdit.classList.add("textarea-warning");
  }
  if (charDescriptionEdit) {
    charDescriptionEdit.readOnly = false;
    charDescriptionEdit.classList.add("textarea-warning");
  }
  charInfoEditBtn?.classList.add("hidden");
  charInfoSaveBtn?.classList.remove("hidden");
  charInfoCancelBtn?.classList.remove("hidden");
});

// 取消按钮
charInfoCancelBtn?.addEventListener("click", () => {
  if (charGreetingEdit) {
    charGreetingEdit.readOnly = true;
    charGreetingEdit.classList.remove("textarea-warning");
  }
  if (charDescriptionEdit) {
    charDescriptionEdit.readOnly = true;
    charDescriptionEdit.classList.remove("textarea-warning");
    charDescriptionEdit.value = _charInfoOriginal.description_markdown;
  }
  charInfoEditBtn?.classList.remove("hidden");
  charInfoSaveBtn?.classList.add("hidden");
  charInfoCancelBtn?.classList.add("hidden");
});

// 保存按钮 — 保存开场白和角色描述到角色卡
charInfoSaveBtn?.addEventListener("click", async () => {
  const charId = getCurrentCharId();
  if (!charId) {
    showToast("没有加载角色卡", "error");
    return;
  }

  try {
    // 读取当前编辑的值
    const newDescription = charDescriptionEdit?.value || "";
    const newGreeting = charGreetingEdit?.value || "";

    // 通过 beilu-home 的 update-char API 更新角色卡 chardata.json
    const saveResp = await fetch(
      `/api/parts/shells:beilu-home/update-char/${encodeURIComponent(charId)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description: newDescription,
        }),
      },
    );

    if (!saveResp.ok) {
      const errData = await saveResp.json().catch(() => ({}));
      throw new Error(
        errData.message || errData.error || `HTTP ${saveResp.status}`,
      );
    }

    // 更新本地缓存
    _charInfoOriginal.description_markdown = newDescription;

    // 退出编辑模式
    charInfoCancelBtn?.click();
    showToast("角色信息已保存", "success");
  } catch (err) {
    showToast("保存失败: " + err.message, "error");
  }
});

// ============================================================
// 初始化
// ============================================================

async function init() {
  applyTheme();

  // 初始化 ST 兼容层（EventBus + Globals + CDN 预加载）
  try {
    initSTCompat();
  } catch (e) {
    console.warn("[beilu-chat] initSTCompat 失败（非致命）:", e.message);
  }

  try {
    await initTranslations("chat");
  } catch (e) {
    console.warn("[beilu-chat] initTranslations 失败（非致命）:", e.message);
  }

  try {
    usingTemplates("/parts/shells:beilu-chat/src/templates");
  } catch (e) {
    console.warn("[beilu-chat] usingTemplates 失败（非致命）:", e.message);
  }

  // 初始化三栏布局（折叠/选项卡交互）
  try {
    initLayout();
  } catch (e) {
    console.warn("[beilu-chat] initLayout 失败（非致命）:", e.message);
  }

  // 字体比例控制已在 initLayout() → initFeatureControls() 中初始化，不再重复调用

  try {
    await initializeChat();
  } catch (e) {
    console.warn("[beilu-chat] initializeChat 失败（非致命）:", e.message);
  }

  // 初始化 API 配置模块
  try {
    initApiConfig();
  } catch (e) {
    console.warn("[beilu-chat] initApiConfig 失败（非致命）:", e.message);
  }

  // 模型获取按钮 + 下拉联动
  apiFetchModelsBtn?.addEventListener("click", fetchModels);
  apiModelSelect?.addEventListener("change", () => {
    if (apiModelSelect.value) {
      const apiModelInput = document.getElementById("api-model");
      if (apiModelInput) apiModelInput.value = apiModelSelect.value;
    }
  });

  // 单次注入按钮 — 展开/折叠注入面板
  initSingleInjectPanel();

  // 加载预设数据（面板默认打开预设 tab）— 带重试
  await loadPresetDataWithRetry();

  // 加载 API 服务源配置（右栏下拉框）
  loadApiConfig();

  // 刷新按钮
  document
    .getElementById("preset-refresh-btn")
    ?.addEventListener("click", () => {
      loadPresetData();
      showToast("预设数据已刷新", "info");
    });

  // 初始化记忆 dataTable（自动绑定当前角色卡）
  ensureDataTableInit();

  // 初始化角色快捷信息面板（左栏）
  try {
    await initCharInfoPanel();
  } catch (e) {
    console.warn("[beilu-chat] initCharInfoPanel 失败（非致命）:", e.message);
  }

  // 初始化世界书绑定（左栏）
  try {
    await initWorldBinding();
  } catch (e) {
    console.warn("[beilu-chat] initWorldBinding 失败（非致命）:", e.message);
  }

  // 初始化用户人设选择（左栏）
  try {
    await initPersonaSelector();
  } catch (e) {
    console.warn("[beilu-chat] initPersonaSelector 失败（非致命）:", e.message);
  }

  // 初始化记忆AI手动操作按钮（右栏）
  try {
    initMemoryOps();
  } catch (e) {
    console.warn("[beilu-chat] initMemoryOps 失败（非致命）:", e.message);
  }

  // 初始化记忆文件浏览器（侧边栏文件树 + 文件查看器）
  try {
    const memoryTreeEl = document.getElementById("memory-tree");
    const memoryFileViewer = document.getElementById("memory-file-viewer");
    if (memoryTreeEl) {
      const charId = getCurrentCharId();
      await initMemoryBrowser(memoryTreeEl, memoryFileViewer, {
        charId: charId || "",
      });

      // 如果角色卡还没加载好，延迟绑定文件浏览器
      if (!charId) {
        const retryTimer = setInterval(() => {
          const id = getCurrentCharId();
          if (id) {
            clearInterval(retryTimer);
            bindMemoryBrowserToChar(id);
            console.log("[beilu-chat] memoryBrowser 延迟绑定角色卡:", id);
          }
        }, 2000);
        setTimeout(() => clearInterval(retryTimer), 30000);
      }
    }
  } catch (e) {
    console.warn("[beilu-chat] initMemoryBrowser 失败（非致命）:", e.message);
  }
  // 初始化正则编辑器（前端助手选项卡）
  try {
    const regexContainer = document.getElementById("regex-editor-container");
    if (regexContainer) await initRegexEditor(regexContainer);
  } catch (e) {
    console.warn("[beilu-chat] initRegexEditor 失败（非致命）:", e.message);
  }

  // 初始化变量管理器（前端助手选项卡 — 变量面板）
  try {
    const varContainer = document.getElementById("variable-manager-container");
    if (varContainer) initVariableManager(varContainer);
  } catch (e) {
    console.warn("[beilu-chat] initVariableManager 失败（非致命）:", e.message);
  }

  // 初始化脚本管理器（前端助手选项卡 — 脚本面板）
  try {
    const scriptContainer = document.getElementById("script-manager-container");
    if (scriptContainer) initScriptManager(scriptContainer);
  } catch (e) {
    console.warn("[beilu-chat] initScriptManager 失败（非致命）:", e.message);
  }

  // 初始化插件管理器（前端助手选项卡 — 插件面板）
  try {
    const pluginContainer = document.getElementById("plugin-manager-container");
    if (pluginContainer) initPluginManager(pluginContainer);
  } catch (e) {
    console.warn("[beilu-chat] initPluginManager 失败（非致命）:", e.message);
  }

  // 初始化助手子选项卡切换
  initHelperSubTabs();

  // 初始化 Bot 子选项卡切换
  initBotSubTabs();

  // 初始化注入提示词列表（右栏折叠组）
  try {
    await initInjectionPromptList();
  } catch (e) {
    console.warn(
      "[beilu-chat] initInjectionPromptList 失败（非致命）:",
      e.message,
    );
  }

  // 初始化文件浏览器（IDE 侧边栏的文件资源管理器面板）
  try {
    const fileTree = document.getElementById("ide-panel-explorer");
    const fileEditor = document.getElementById("file-editor-area");
    if (fileTree && fileEditor) await initFileExplorer(fileTree, fileEditor);
  } catch (e) {
    console.warn("[beilu-chat] initFileExplorer 失败（非致命）:", e.message);
  }

  // 页面可见性变化时自动刷新数据（从 beilu-home 切回时同步）
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      console.log("[beilu-chat] 页面重新可见，刷新预设和API数据");
      loadPresetData();
      loadApiConfig();
      // 刷新 dataTable 和文件浏览器角色卡绑定
      const charId = getCurrentCharId();
      if (charId) {
        bindDataTableToChar(charId);
        bindMemoryBrowserToChar(charId);
      }
    }
  });

  // 初始化提示词查看器悬浮窗
  try {
    initPromptViewer();
  } catch (e) {
    console.warn("[beilu-chat] initPromptViewer 失败（非致命）:", e.message);
  }

  // 初始化≡扩展菜单
  initExtendMenu();

  // 初始化功能开关面板
  initFeatureToggles();

  // 加载 INJ-2 状态（用于扩展菜单中的手动切换）
  loadInj2Status();

  // 初始化记忆AI输出面板（轮询 + 渲染 + 自动清空）
  try {
    initMemoryOutputPanel();
  } catch (e) {
    console.warn(
      "[beilu-chat] initMemoryOutputPanel 失败（非致命）:",
      e.message,
    );
  }

  // 初始化记忆AI面板折叠交互
  initMemoryAIPanelCollapse();

  // 初始化记忆AI预设交互模块（侧边栏预设面板 + AI对话面板）
  try {
    await initMemoryPresetChat();
  } catch (e) {
    console.warn(
      "[beilu-chat] initMemoryPresetChat 失败（非致命）:",
      e.message,
    );
  }

  // 初始化角色卡脚本系统（tavern_helper 脚本 iframe）
  try {
    await initCharacterScriptSystem();
  } catch (e) {
    console.warn(
      "[beilu-chat] initCharacterScriptSystem 失败（非致命）:",
      e.message,
    );
  }

  // 启动贝露的眼睛（桌面截图）主动发送轮询
  try {
    startEyeActivePoll();
  } catch (e) {
    console.warn("[beilu-chat] startEyeActivePoll 失败（非致命）:", e.message);
  }

  // 启动浏览器感知主动发送轮询
  try {
    startBrowserActivePoll();
  } catch (e) {
    console.warn(
      "[beilu-chat] startBrowserActivePoll 失败（非致命）:",
      e.message,
    );
  }

  // 启动文件操作结果自动继续轮询
  try {
    startFileOpResultPoll();
  } catch (e) {
    console.warn(
      "[beilu-chat] startFileOpResultPoll 失败（非致命）:",
      e.message,
    );
  }

  console.log(
    "[beilu-chat] Shell 已加载 — Phase 4 三栏布局 + 聊天 + 预设 + API 配置 + dataTable 记忆编辑器 + 正则编辑器 + 文件浏览器 + 提示词查看器 + 记忆AI输出面板 + 记忆AI预设交互",
  );
}

/**
 * 带重试的预设数据加载
 * 首次加载失败时，延迟重试最多 3 次（应对插件路由未就绪的时序问题）
 */
async function loadPresetDataWithRetry() {
  const MAX_RETRIES = 3;
  const RETRY_DELAY = 1500; // ms

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const data = await getPresetData();
      // 检查返回数据是否有效（preset_list 非空 或 preset_loaded 为 true）
      if (data.preset_list?.length > 0 || data.preset_loaded) {
        console.log(`[beilu-chat] 预设数据加载成功（第${attempt}次尝试）`);
        applyPresetData(data);
        return;
      }
      // 数据有效但确实没有预设（preset_list 为空数组）
      if (Array.isArray(data.preset_list)) {
        console.log(
          `[beilu-chat] 预设数据为空（后端无预设），第${attempt}次尝试`,
        );
        applyPresetData(data);
        return;
      }
    } catch (err) {
      console.warn(`[beilu-chat] 预设加载第${attempt}次失败:`, err.message);
    }

    if (attempt < MAX_RETRIES) {
      console.log(`[beilu-chat] ${RETRY_DELAY}ms 后重试...`);
      await new Promise((r) => setTimeout(r, RETRY_DELAY));
    }
  }
  // 所有重试都失败，回退到普通加载
  console.warn("[beilu-chat] 预设加载重试耗尽，执行普通加载");
  await loadPresetData();
}

// ============================================================
// 单次注入面板（💉 按钮展开/折叠）
// ============================================================

/**
 * 初始化单次注入面板的展开/折叠逻辑
 * 💉 按钮点击 → 切换面板显隐
 * 关闭按钮 → 隐藏面板
 */
function initSingleInjectPanel() {
  const btn = document.getElementById("single-inject-btn");
  const panel = document.getElementById("single-inject-panel");
  const closeBtn = document.getElementById("single-inject-close");
  const textarea = document.getElementById("single-inject");

  if (!btn || !panel) return;

  btn.addEventListener("click", () => {
    const isHidden = panel.classList.contains("hidden");
    panel.classList.toggle("hidden");
    if (isHidden && textarea) {
      textarea.focus();
    }
  });

  closeBtn?.addEventListener("click", () => {
    panel.classList.add("hidden");
  });
}

// ============================================================
// 功能开关面板（右栏插件管理区域）
// ============================================================

function initFeatureToggles() {
  // 角色名显示开关
  const charNamesToggle = document.getElementById("toggle-char-names");
  if (charNamesToggle) {
    const saved = localStorage.getItem("beilu-hide-char-names");
    charNamesToggle.checked = saved !== "true";
    if (saved === "true") document.body.classList.add("hide-char-names");
    charNamesToggle.addEventListener("change", () => {
      if (charNamesToggle.checked) {
        document.body.classList.remove("hide-char-names");
        localStorage.setItem("beilu-hide-char-names", "false");
      } else {
        document.body.classList.add("hide-char-names");
        localStorage.setItem("beilu-hide-char-names", "true");
      }
    });
  }

  // 正则处理器开关（占位 — 后续连接到 regexEditor）
  const regexToggle = document.getElementById("toggle-regex");
  if (regexToggle) {
    const saved = localStorage.getItem("beilu-regex-enabled");
    regexToggle.checked = saved !== "false";
  }

  // 思维链折叠开关（占位 — 后续连接到 chat 渲染器）
  const thinkingToggle = document.getElementById("toggle-thinking-fold");
  if (thinkingToggle) {
    const saved = localStorage.getItem("beilu-thinking-fold");
    thinkingToggle.checked = saved !== "false";
  }

  // 感知消息显示开关（控制 beilu-eye 截图消息是否在聊天界面显示）
  const senseMessagesToggle = document.getElementById("toggle-sense-messages");
  if (senseMessagesToggle) {
    const saved = localStorage.getItem("beilu-show-sense-messages");
    senseMessagesToggle.checked = saved === "true";
    senseMessagesToggle.addEventListener("change", () => {
      localStorage.setItem(
        "beilu-show-sense-messages",
        senseMessagesToggle.checked ? "true" : "false",
      );
      console.log(
        `[beilu-chat] 感知消息显示: ${senseMessagesToggle.checked ? "开启" : "关闭"}`,
      );
    });
  }

  // AI 文件处理能力权限开关 — 同步到 beilu-files 插件
  initFilePermissionToggles();
}

/**
 * 初始化 AI 文件处理能力权限开关
 * 从后端加载当前权限状态，绑定开关 change 事件
 */
async function initFilePermissionToggles() {
  const toggles = document.querySelectorAll("[data-permission]");
  if (toggles.length === 0) return;

  // 从后端加载当前权限状态
  try {
    const res = await fetch("/api/parts/plugins:beilu-files/config/getdata");
    if (res.ok) {
      const data = await res.json();
      const permissions = data.permissions || {};

      // 同步 UI 状态
      toggles.forEach((toggle) => {
        const perm = toggle.dataset.permission;
        if (perm && permissions[perm] !== undefined) {
          toggle.checked = permissions[perm];
        }
      });
    }
  } catch (err) {
    console.warn("[beilu-chat] 加载文件权限状态失败:", err.message);
  }

  // 绑定 change 事件 — 每次变更同步到后端
  toggles.forEach((toggle) => {
    toggle.addEventListener("change", async () => {
      const perm = toggle.dataset.permission;
      if (!perm) return;

      try {
        await fetch("/api/parts/plugins:beilu-files/config/setdata", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            permissions: { [perm]: toggle.checked },
          }),
        });
        console.log(`[beilu-chat] 文件权限更新: ${perm} = ${toggle.checked}`);
      } catch (err) {
        console.warn(`[beilu-chat] 更新文件权限 ${perm} 失败:`, err.message);
        // 回退 UI 状态
        toggle.checked = !toggle.checked;
      }
    });
  });

  console.log(
    "[beilu-chat] AI 文件处理能力权限开关已初始化:",
    toggles.length,
    "个",
  );
}

// ============================================================
// ≡ 扩展工具菜单
// ============================================================

function initExtendMenu() {
  const menuBtn = document.getElementById("extend-menu-btn");
  const menu = document.getElementById("extend-menu");
  if (!menuBtn || !menu) return;

  /**
   * 根据按钮位置动态定位菜单（fixed 定位，向上弹出）
   */
  function positionMenu() {
    const rect = menuBtn.getBoundingClientRect();
    // 菜单在按钮上方弹出
    menu.style.left = rect.left + "px";
    menu.style.bottom = window.innerHeight - rect.top + 4 + "px";
    // 清除可能的 top 值
    menu.style.top = "auto";
  }

  // 切换菜单显隐
  menuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const wasHidden = menu.classList.contains("hidden");
    menu.classList.toggle("hidden");
    if (wasHidden) positionMenu();
  });

  // 点击菜单外关闭
  document.addEventListener("click", (e) => {
    if (
      !menu.contains(e.target) &&
      e.target !== menuBtn &&
      !menuBtn.contains(e.target)
    ) {
      menu.classList.add("hidden");
    }
  });

  // 菜单项点击
  menu.querySelectorAll(".extend-menu-item").forEach((item) => {
    item.addEventListener("click", () => {
      const action = item.dataset.action;
      menu.classList.add("hidden");

      switch (action) {
        case "new-chat":
          handleNewChat();
          break;
        case "manage-chats":
          handleManageChats();
          break;
        case "batch-delete":
          handleBatchDelete();
          break;
        case "regenerate":
          handleRegenerate();
          break;
        case "toggle-inj2":
          handleToggleInj2();
          break;
        case "prompt-viewer":
          openPromptViewer();
          break;
        case "toggle-memory-ai":
          toggleMemoryAIPanel();
          break;
        default:
          console.warn("[extendMenu] 未知操作:", action);
      }
    });
  });
}

// ============================================================
// 记忆AI输出面板 — 折叠/展开控制
// ============================================================

/** 记忆AI面板是否被用户手动隐藏 */
let _memoryAIPanelHidden = false;
/** 记忆AI面板 body 是否折叠 */
let _memoryAIBodyCollapsed = false;

/**
 * 切换记忆AI面板的显示/隐藏（从扩展菜单触发）
 */
function toggleMemoryAIPanel() {
  const panel = document.getElementById("memory-ai-output");
  if (!panel) return;

  const isHidden = panel.style.display === "none";
  if (isHidden) {
    panel.style.display = "";
    _memoryAIPanelHidden = false;
    _memoryOutputDismissed = false;
  } else {
    panel.style.display = "none";
    _memoryAIPanelHidden = true;
  }
  updateMemoryAIToggleStatus();
}

/**
 * 更新扩展菜单中记忆AI菜单项的状态文字
 */
function updateMemoryAIToggleStatus() {
  const statusEl = document.getElementById("memory-ai-toggle-status");
  if (!statusEl) return;
  const panel = document.getElementById("memory-ai-output");
  const isVisible = panel && panel.style.display !== "none";
  statusEl.textContent = isVisible ? "ON" : "OFF";
}

/**
 * 初始化记忆AI面板的折叠交互
 */
function initMemoryAIPanelCollapse() {
  const headerToggle = document.getElementById(
    "memory-ai-output-header-toggle",
  );
  const body = document.getElementById("memory-ai-output-body");
  const chevron = document.getElementById("memory-ai-output-chevron");
  const closeBtn = document.getElementById("memory-ai-output-close");

  if (headerToggle && body) {
    headerToggle.addEventListener("click", (e) => {
      // 如果点击的是关闭按钮，不触发折叠
      if (e.target === closeBtn || closeBtn?.contains(e.target)) return;

      _memoryAIBodyCollapsed = !_memoryAIBodyCollapsed;
      body.style.display = _memoryAIBodyCollapsed ? "none" : "";
      if (chevron) {
        chevron.textContent = _memoryAIBodyCollapsed ? "▶" : "▼";
      }
    });
  }
}

// ============================================================
// INJ-2 文件层AI提示词 — 手动切换
// ============================================================

/** INJ-2 当前状态缓存（从后端读取，避免依赖 DOM 元素） */
let _inj2Enabled = null;

/**
 * 初始化时从后端读取 INJ-2 状态
 */
async function loadInj2Status() {
  try {
    const charId = getCurrentCharId();
    const params = new URLSearchParams();
    if (charId) params.set("char_id", charId);
    const resp = await fetch(
      `/api/parts/plugins:beilu-memory/config/getdata?${params}`,
    );
    if (!resp.ok) return;
    const data = await resp.json();
    const inj2 = (data.injection_prompts || []).find((p) => p.id === "INJ-2");
    if (inj2) {
      _inj2Enabled = inj2.enabled;
      const statusEl = document.getElementById("inj2-status");
      if (statusEl) statusEl.textContent = _inj2Enabled ? "ON" : "OFF";
    }
  } catch {
    /* 静默失败 */
  }
}

async function handleToggleInj2() {
  // 首次调用时从后端加载状态
  if (_inj2Enabled === null) {
    await loadInj2Status();
  }
  const newState = !_inj2Enabled;
  const charId = getCurrentCharId();
  try {
    await fetch("/api/parts/plugins:beilu-memory/config/setdata", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        _action: "updateInjectionPrompt",
        injectionId: "INJ-2",
        enabled: newState,
        charName: charId || "_global",
      }),
    });
    _inj2Enabled = newState;
    const statusEl = document.getElementById("inj2-status");
    if (statusEl) statusEl.textContent = newState ? "ON" : "OFF";
    showToast(`文件层AI提示词: ${newState ? "已开启" : "已关闭"}`, "info");
  } catch (err) {
    showToast("切换失败: " + err.message, "error");
  }
}

// ============================================================
// 记忆AI输出面板（轮询 + 渲染 + 自动清空）
// ============================================================

/** 轮询定时器 */
let _memoryOutputPollTimer = null;
/** 已渲染的最大 ID（增量获取） */
let _memoryOutputLastId = 0;
/** 面板是否被用户手动关闭 */
let _memoryOutputDismissed = false;
/** 当前状态（running/done/error/null） */
let _memoryOutputCurrentStatus = null;
/** 自动清空倒计时 ID */
let _memoryOutputClearTimeout = null;

/**
 * 启动记忆AI输出轮询
 */
function startMemoryOutputPoll() {
  if (_memoryOutputPollTimer) return;
  _memoryOutputPollTimer = setInterval(pollMemoryAIOutput, 2000);
  // 立即执行一次
  pollMemoryAIOutput();
}

/**
 * 停止轮询
 */
function stopMemoryOutputPoll() {
  if (_memoryOutputPollTimer) {
    clearInterval(_memoryOutputPollTimer);
    _memoryOutputPollTimer = null;
  }
}

/**
 * 轮询后端获取新的记忆AI输出
 */
async function pollMemoryAIOutput() {
  try {
    const resp = await fetch("/api/parts/plugins:beilu-memory/config/setdata", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        _action: "getMemoryAIOutput",
        sinceId: _memoryOutputLastId,
      }),
    });
    if (!resp.ok) return;
    const data = await resp.json();
    if (!data.outputs || data.outputs.length === 0) return;

    // 渲染新输出
    renderMemoryAIOutputs(data.outputs);

    // 更新 lastId
    const maxId = Math.max(...data.outputs.map((o) => o.id));
    if (maxId > _memoryOutputLastId) _memoryOutputLastId = maxId;

    // 检查状态 — 如果最后一条是 done/error，启动自动清空倒计时
    const lastOutput = data.outputs[data.outputs.length - 1];
    if (lastOutput.status) {
      _memoryOutputCurrentStatus = lastOutput.status;
      updateMemoryOutputStatusUI(lastOutput.status);

      if (lastOutput.status === "done" || lastOutput.status === "error") {
        // 任务完成/出错，停止轮询避免无意义请求
        stopMemoryOutputPoll();
        // 取消之前的倒计时（如果有）
        if (_memoryOutputClearTimeout) clearTimeout(_memoryOutputClearTimeout);
        // 5秒后自动清空面板
        _memoryOutputClearTimeout = setTimeout(() => {
          clearMemoryOutputPanel();
          _memoryOutputClearTimeout = null;
        }, 5000);
      } else if (lastOutput.status === "running") {
        // running 状态取消之前的清空倒计时
        if (_memoryOutputClearTimeout) {
          clearTimeout(_memoryOutputClearTimeout);
          _memoryOutputClearTimeout = null;
        }
      }
    }
  } catch {
    // 静默失败
  }
}

/**
 * 渲染记忆AI输出到面板
 * @param {Array<object>} outputs - 输出条目数组
 */
function renderMemoryAIOutputs(outputs) {
  const panel = document.getElementById("memory-ai-output");
  const body = document.getElementById("memory-ai-output-body");
  if (!panel || !body) return;

  // 面板不自动弹出。如果面板当前不可见（用户未手动打开），只静默更新数据不渲染
  if (
    _memoryOutputDismissed ||
    _memoryAIPanelHidden ||
    panel.style.display === "none"
  )
    return;

  outputs.forEach((output) => {
    const entry = document.createElement("div");
    entry.className = "memory-ai-output-entry";

    if (output.status === "running") {
      entry.classList.add("entry-status");
      entry.textContent = `⏳ ${output.presetName || "记忆AI"} 处理中...`;
    } else if (output.status === "done") {
      entry.classList.add("entry-status");
      if (output.reply) {
        const preview =
          output.reply.length > 200
            ? output.reply.substring(0, 200) + "…"
            : output.reply;
        entry.innerHTML =
          `<div class="font-medium">✅ ${escapeHtml(output.presetName || "记忆AI")} 完成</div>` +
          (output.totalRounds > 1
            ? `<div class="text-xs opacity-50">${output.totalRounds}轮, ${output.totalTimeMs || 0}ms</div>`
            : "") +
          `<div class="text-xs mt-1 whitespace-pre-wrap">${escapeHtml(preview)}</div>`;
      } else {
        entry.textContent = `✅ ${output.presetName || "记忆AI"}: 处理完成`;
      }
    } else if (output.status === "error") {
      entry.classList.add("entry-status", "entry-error");
      entry.textContent = `❌ ${output.presetName || "记忆AI"}: ${output.error || "处理出错"}`;
    } else if (output.type === "content") {
      entry.classList.add("entry-content");
      entry.textContent = output.content || "";
    } else {
      // 未知格式回退
      entry.classList.add("entry-content");
      entry.textContent =
        output.reply || output.content || JSON.stringify(output);
    }

    body.appendChild(entry);
  });

  // 自动滚动到底部
  body.scrollTop = body.scrollHeight;
}

/**
 * 更新状态标签 UI
 * @param {string} status - running/done/error
 */
function updateMemoryOutputStatusUI(status) {
  const statusEl = document.getElementById("memory-ai-output-status");
  if (!statusEl) return;

  statusEl.className = "memory-ai-output-status";
  switch (status) {
    case "running":
      statusEl.textContent = "⏳ 处理中";
      statusEl.classList.add("status-running");
      break;
    case "done":
      statusEl.textContent = "✅ 完成";
      statusEl.classList.add("status-done");
      break;
    case "error":
      statusEl.textContent = "❌ 出错";
      statusEl.classList.add("status-error");
      break;
    default:
      statusEl.textContent = "";
  }
}

/**
 * 清空面板并隐藏（自动或手动）
 */
async function clearMemoryOutputPanel() {
  const panel = document.getElementById("memory-ai-output");
  const body = document.getElementById("memory-ai-output-body");
  if (body) body.innerHTML = "";
  if (panel) panel.style.display = "none";
  _memoryOutputCurrentStatus = null;

  // 通知后端清空队列
  try {
    await fetch("/api/parts/plugins:beilu-memory/config/setdata", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ _action: "clearMemoryAIOutput" }),
    });
  } catch {
    /* 静默 */
  }

  // 不重置 _memoryOutputLastId，避免下次轮询重新获取已显示的旧消息导致无限循环

  const statusEl = document.getElementById("memory-ai-output-status");
  if (statusEl) {
    statusEl.textContent = "";
    statusEl.className = "memory-ai-output-status";
  }
}

/**
 * 初始化记忆AI输出面板（事件绑定 + 启动轮询）
 */
function initMemoryOutputPanel() {
  // 关闭按钮
  document
    .getElementById("memory-ai-output-close")
    ?.addEventListener("click", () => {
      _memoryOutputDismissed = true;
      const panel = document.getElementById("memory-ai-output");
      if (panel) panel.style.display = "none";
    });

  // 轮询不在页面加载时自动启动，改为按需启动（记忆AI操作触发时）
  // startMemoryOutputPoll()
}

// ============================================================
// ≡ 扩展菜单 — 操作处理
// ============================================================

/**
 * 导航到指定聊天（同窗口跳转）
 * 更新 hash 并重载页面，让 currentChatId / WebSocket / VirtualQueue 全部重新初始化
 * @param {string} chatid - 目标聊天ID
 */
function navigateToChat(chatid) {
  window.location.hash = "#" + chatid;
  window.location.reload();
}

/**
 * 开始新聊天（创建聊天文件并跳转到新聊天）
 */
async function handleNewChat() {
  try {
    // 记住当前角色卡，以便新聊天自动添加并获取开场白
    const currentChar = charList && charList.length > 0 ? charList[0] : null;

    const res = await fetch("/api/parts/shells:chat/new", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    // 自动添加当前角色卡（后端 addchar 会自动获取 greeting 并保存）
    if (currentChar) {
      try {
        await fetch(`/api/parts/shells:chat/${data.chatid}/char`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ charname: currentChar }),
        });
      } catch (err) {
        console.warn("[beilu-chat] 新聊天自动添加角色失败:", err.message);
      }
    }

    showToast(`已创建新聊天，正在跳转…`, "success");
    // 跳转到新聊天
    navigateToChat(data.chatid);
  } catch (err) {
    showToast("创建新聊天失败: " + err.message, "error");
  }
}

/**
 * 管理聊天文件（弹出聊天列表弹窗）
 */
async function handleManageChats() {
  try {
    const res = await fetch("/api/parts/shells:chat/getchatlist");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const allChats = await res.json();

    // 按当前角色卡过滤聊天列表（只显示当前角色的聊天）
    const currentChar = charList && charList.length > 0 ? charList[0] : null;
    const filteredChats = currentChar
      ? allChats.filter(
          (chat) => chat.chars && chat.chars.includes(currentChar),
        )
      : allChats;

    showChatManagerModal(filteredChats, currentChar);
  } catch (err) {
    showToast("获取聊天列表失败: " + err.message, "error");
  }
}

/**
 * 批量删除消息（弹出消息选择弹窗）
 */
function handleBatchDelete() {
  const queue = getQueue();
  if (queue.length === 0) {
    showToast("没有可删除的消息", "warning");
    return;
  }
  showBatchDeleteModal(queue);
}

/**
 * 重新生成最后一条 AI 回复
 */
async function handleRegenerate() {
  const queue = getQueue();
  if (queue.length === 0) {
    showToast("没有可重新生成的消息", "warning");
    return;
  }

  const lastMsg = queue[queue.length - 1];
  if (lastMsg.role !== "char") {
    showToast("最后一条消息不是 AI 回复，无法重新生成", "warning");
    return;
  }

  try {
    await modifyTimeLine(1); // 向右切换 = 生成新的时间线分支
    showToast("正在重新生成…", "info");
  } catch (err) {
    showToast("重新生成失败: " + err.message, "error");
  }
}

/**
 * 显示批量删除消息弹窗
 * @param {Array<object>} queue - 消息队列
 */
function showBatchDeleteModal(queue) {
  document.getElementById("batch-delete-overlay")?.remove();

  const overlay = document.createElement("div");
  overlay.id = "batch-delete-overlay";
  overlay.className = "fp-overlay";
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });

  const modal = document.createElement("div");
  modal.className = "fp-modal";
  modal.style.width = "580px";

  // 标题栏
  const header = document.createElement("div");
  header.className = "fp-header";
  header.innerHTML = `
		<span class="fp-title">🗑️ 批量删除消息</span>
		<button class="fp-close-btn" title="关闭">×</button>
	`;
  header
    .querySelector(".fp-close-btn")
    .addEventListener("click", () => overlay.remove());

  // 消息列表
  const listContainer = document.createElement("div");
  listContainer.className = "fp-list-container";
  listContainer.style.maxHeight = "450px";

  const selectedIndices = new Set();

  queue.forEach((msg, qIdx) => {
    const chatLogIdx = getChatLogIndexByQueueIndex(qIdx);
    const item = document.createElement("div");
    item.className = "fp-item batch-del-item";
    item.style.cursor = "pointer";

    const roleIcon =
      msg.role === "user" ? "👤" : msg.role === "char" ? "🤖" : "🔧";
    const name = msg.name || (msg.role === "user" ? "用户" : "AI");
    const preview = (msg.content || "").replace(/\n/g, " ").slice(0, 60);
    const time = msg.time_stamp
      ? new Date(msg.time_stamp).toLocaleTimeString()
      : "";

    item.innerHTML = `
			<label style="display:flex;align-items:center;gap:8px;flex:1;min-width:0;cursor:pointer;">
				<input type="checkbox" class="checkbox checkbox-xs checkbox-warning batch-del-cb"
					data-queue-idx="${qIdx}" data-chatlog-idx="${chatLogIdx}" />
				<span style="font-size:0.75rem;flex-shrink:0;">${roleIcon}</span>
				<span style="font-size:0.75rem;font-weight:500;max-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0;">${escapeHtml(name)}</span>
				<span style="font-size:0.7rem;opacity:0.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;">${escapeHtml(preview)}${preview.length >= 60 ? "…" : ""}</span>
			</label>
			<span style="font-size:0.6rem;opacity:0.3;flex-shrink:0;">${time}</span>
		`;

    const cb = item.querySelector(".batch-del-cb");
    cb.addEventListener("change", () => {
      if (cb.checked) selectedIndices.add(chatLogIdx);
      else selectedIndices.delete(chatLogIdx);
      updateBatchDeleteFooter();
    });

    // 点击行也切换 checkbox（但不影响 label 内的 checkbox 自身事件）
    item.addEventListener("click", (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "LABEL") return;
      cb.checked = !cb.checked;
      cb.dispatchEvent(new Event("change"));
    });

    listContainer.appendChild(item);
  });

  // 底部
  const footer = document.createElement("div");
  footer.className = "fp-footer";
  footer.innerHTML = `
		<div style="display:flex;align-items:center;gap:6px;">
			<button class="dt-btn dt-btn-sm" id="bd-select-all">全选</button>
			<button class="dt-btn dt-btn-sm" id="bd-deselect-all">取消全选</button>
			<span class="fp-selected-label" id="bd-count">已选 0 条</span>
		</div>
		<div class="fp-footer-buttons">
			<button class="fp-confirm-btn" id="bd-confirm" style="background:#dc2626;border-color:#dc2626;" disabled>🗑️ 删除已选</button>
		</div>
	`;

  const countLabel = footer.querySelector("#bd-count");
  const confirmBtn = footer.querySelector("#bd-confirm");

  function updateBatchDeleteFooter() {
    countLabel.textContent = `已选 ${selectedIndices.size} 条`;
    confirmBtn.disabled = selectedIndices.size === 0;
  }

  // 全选
  footer.querySelector("#bd-select-all").addEventListener("click", () => {
    listContainer.querySelectorAll(".batch-del-cb").forEach((cb) => {
      cb.checked = true;
      selectedIndices.add(parseInt(cb.dataset.chatlogIdx));
    });
    updateBatchDeleteFooter();
  });

  // 取消全选
  footer.querySelector("#bd-deselect-all").addEventListener("click", () => {
    listContainer.querySelectorAll(".batch-del-cb").forEach((cb) => {
      cb.checked = false;
    });
    selectedIndices.clear();
    updateBatchDeleteFooter();
  });

  // 确认删除
  confirmBtn.addEventListener("click", async () => {
    if (selectedIndices.size === 0) return;
    if (
      !confirm(
        `确定删除选中的 ${selectedIndices.size} 条消息吗？此操作不可撤销。`,
      )
    )
      return;

    // 从大到小排序索引，避免删除时索引移位
    const sortedIndices = Array.from(selectedIndices).sort((a, b) => b - a);

    confirmBtn.disabled = true;
    confirmBtn.textContent = "⏳ 删除中...";

    let successCount = 0;
    let failCount = 0;

    for (const idx of sortedIndices) {
      try {
        await deleteMessage(idx);
        successCount++;
      } catch (err) {
        console.error(`删除消息 ${idx} 失败:`, err);
        failCount++;
      }
    }

    overlay.remove();

    if (failCount > 0) {
      showToast(`删除完成：${successCount} 成功，${failCount} 失败`, "warning");
    } else {
      showToast(`已删除 ${successCount} 条消息`, "success");
    }
  });

  modal.appendChild(header);
  modal.appendChild(listContainer);
  modal.appendChild(footer);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}

/**
 * 显示聊天管理弹窗
 * @param {Array<object>} chatList - 聊天列表
 */
function showChatManagerModal(chatList, filterCharName) {
  // 移除已存在的弹窗
  document.getElementById("chat-manager-overlay")?.remove();

  const overlay = document.createElement("div");
  overlay.id = "chat-manager-overlay";
  overlay.className = "fp-overlay";
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });

  const modal = document.createElement("div");
  modal.className = "fp-modal";
  modal.style.width = "540px";

  // 标题栏（显示当前角色名，让用户知道是按角色过滤的）
  const titleText = filterCharName
    ? `📂 ${filterCharName} 的聊天`
    : "📂 聊天管理";
  const header = document.createElement("div");
  header.className = "fp-header";
  header.innerHTML = `
		<span class="fp-title">${escapeHtml(titleText)}</span>
		<button class="fp-close-btn" title="关闭">×</button>
	`;
  header
    .querySelector(".fp-close-btn")
    .addEventListener("click", () => overlay.remove());

  // 聊天列表容器
  const listContainer = document.createElement("div");
  listContainer.className = "fp-list-container";
  listContainer.style.maxHeight = "450px";

  if (!chatList || chatList.length === 0) {
    listContainer.innerHTML = '<div class="fp-empty">暂无聊天记录</div>';
  } else {
    chatList.forEach((chat) => {
      const item = document.createElement("div");
      item.className = "fp-item";
      item.style.justifyContent = "space-between";

      const isCurrentChat = chat.chatid === currentChatId;
      const chars = (chat.chars || []).join(", ") || "未知角色";
      const lastTime = chat.lastMessageTime
        ? new Date(chat.lastMessageTime).toLocaleString()
        : "";
      const lastContent = (chat.lastMessageContent || "").slice(0, 40);
      const sender = chat.lastMessageSender || "";

      item.innerHTML = `
				<div style="flex:1;min-width:0;">
					<div style="display:flex;align-items:center;gap:6px;">
						<span class="fp-item-icon">💬</span>
						<span class="fp-item-name" style="font-weight:${isCurrentChat ? "700" : "400"};color:${isCurrentChat ? "var(--beilu-amber)" : "inherit"};">
							${escapeHtml(chars)}${isCurrentChat ? " (当前)" : ""}
						</span>
					</div>
					<div style="font-size:0.7rem;opacity:0.5;padding-left:1.5rem;margin-top:2px;">
						${escapeHtml(sender)}: ${escapeHtml(lastContent)}${lastContent.length >= 40 ? "…" : ""}
					</div>
				</div>
				<div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
					<span style="font-size:0.65rem;opacity:0.4;">${lastTime}</span>
					<button class="chat-open-btn dt-btn dt-btn-sm" title="打开" style="font-size:0.7rem;">打开</button>
					<button class="chat-delete-btn dt-btn dt-btn-sm dt-btn-danger" title="删除" style="font-size:0.7rem;"${isCurrentChat ? " disabled" : ""}>🗑️</button>
				</div>
			`;

      // 打开聊天（同窗口跳转）
      item.querySelector(".chat-open-btn").addEventListener("click", (e) => {
        e.stopPropagation();
        if (isCurrentChat) {
          showToast("已经在当前聊天", "info");
          overlay.remove();
          return;
        }
        overlay.remove();
        navigateToChat(chat.chatid);
      });

      // 删除聊天
      const deleteBtn = item.querySelector(".chat-delete-btn");
      deleteBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (isCurrentChat) return;
        if (!confirm(`确定删除与 "${chars}" 的聊天吗？此操作不可撤销。`))
          return;

        try {
          const res = await fetch("/api/parts/shells:chat/delete", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chatids: [chat.chatid] }),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          item.style.opacity = "0.3";
          item.style.pointerEvents = "none";
          showToast("聊天已删除", "success");
        } catch (err) {
          showToast("删除失败: " + err.message, "error");
        }
      });

      // 双击打开（同窗口跳转）
      item.addEventListener("dblclick", () => {
        if (isCurrentChat) return;
        overlay.remove();
        navigateToChat(chat.chatid);
      });

      listContainer.appendChild(item);
    });
  }

  // 底部
  const footer = document.createElement("div");
  footer.className = "fp-footer";
  footer.innerHTML = `
		<span class="fp-selected-label">${chatList.length} 个聊天</span>
		<div class="fp-footer-buttons">
			<button class="fp-confirm-btn" id="cm-new-chat-btn">💬 新建聊天</button>
		</div>
	`;
  footer
    .querySelector("#cm-new-chat-btn")
    .addEventListener("click", async () => {
      overlay.remove();
      await handleNewChat(); // handleNewChat 内部会创建并跳转
    });

  modal.appendChild(header);
  modal.appendChild(listContainer);
  modal.appendChild(footer);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}

// ============================================================
// 助手子选项卡切换（正则 / 变量管理器）
// ============================================================

function initHelperSubTabs() {
  const tabs = document.querySelectorAll(".helper-sub-tab");
  if (tabs.length === 0) return;

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const targetTab = tab.dataset.helperTab;
      if (!targetTab) return;

      // 更新 tab 高亮
      tabs.forEach((t) =>
        t.classList.toggle(
          "helper-sub-tab-active",
          t.dataset.helperTab === targetTab,
        ),
      );

      // 切换面板
      document.querySelectorAll(".helper-panel").forEach((panel) => {
        panel.style.display =
          panel.id === `helper-panel-${targetTab}` ? "" : "none";
      });
    });
  });
}

// ============================================================
// Bot 面板初始化（仅 Discord）
// ============================================================

function initBotSubTabs() {
  // 初始化 Discord Bot 面板（Bot tab 已简化为仅 Discord）
  try {
    initDiscordBotPanel();
  } catch (e) {
    console.warn("[beilu-chat] initDiscordBotPanel 失败（非致命）:", e.message);
  }
}

// ============================================================
// Discord Bot 管理面板
// ============================================================

/**
 * Discord Bot API（复用 discordbot shell 的后端端点）
 */
const DC_API = {
  getBotList: () =>
    fetch("/api/parts/shells:discordbot/getbotlist").then((r) => r.json()),
  getBotConfig: (name) =>
    fetch(
      `/api/parts/shells:discordbot/getbotconfig?botname=${encodeURIComponent(name)}`,
    ).then((r) => r.json()),
  setBotConfig: (name, config) =>
    fetch("/api/parts/shells:discordbot/setbotconfig", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ botname: name, config }),
    }).then((r) => r.json()),
  newBotConfig: (name) =>
    fetch("/api/parts/shells:discordbot/newbotconfig", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ botname: name }),
    }).then((r) => r.json()),
  deleteBotConfig: (name) =>
    fetch("/api/parts/shells:discordbot/deletebotconfig", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ botname: name }),
    }).then((r) => r.json()),
  startBot: (name) =>
    fetch("/api/parts/shells:discordbot/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ botname: name }),
    }).then((r) => r.json()),
  stopBot: (name) =>
    fetch("/api/parts/shells:discordbot/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ botname: name }),
    }).then((r) => r.json()),
  getRunningBotList: () =>
    fetch("/api/parts/shells:discordbot/getrunningbotlist").then((r) =>
      r.json(),
    ),
  getBotConfigTemplate: (charname) =>
    fetch(
      `/api/parts/shells:discordbot/getbotConfigTemplate?charname=${encodeURIComponent(charname)}`,
    ).then((r) => r.json()),
  clearContext: (name) =>
    fetch("/api/parts/shells:discordbot/clearcontext", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ botname: name }),
    }).then((r) => r.json()),
  getMessageLog: (name, since) =>
    fetch(
      `/api/parts/shells:discordbot/messagelog?botname=${encodeURIComponent(name)}${since ? `&since=${since}` : ""}`,
    ).then((r) => r.json()),
  getActiveChannels: (name) =>
    fetch(
      `/api/parts/shells:discordbot/activechannels?botname=${encodeURIComponent(name)}`,
    ).then((r) => r.json()),
};

/** Discord Bot 面板状态 */
let _dcBotList = [];
let _dcSelectedBot = null;
let _dcRunningBots = [];

/**
 * 初始化 Discord Bot 面板
 */
async function initDiscordBotPanel() {
  const botSelect = document.getElementById("dc-bot-select");
  const newBtn = document.getElementById("dc-bot-new");
  const deleteBtn = document.getElementById("dc-bot-delete");
  const configCard = document.getElementById("dc-config-card");
  const emptyState = document.getElementById("dc-empty-state");
  const emptyNewBtn = document.getElementById("dc-empty-new");
  const charSelect = document.getElementById("dc-char-select");
  const bindCurrentBtn = document.getElementById("dc-bind-current");
  const tokenInput = document.getElementById("dc-token");
  const tokenToggle = document.getElementById("dc-token-toggle");
  const configJson = document.getElementById("dc-config-json");
  const saveBtn = document.getElementById("dc-save");
  const saveStatus = document.getElementById("dc-save-status");
  const startStopBtn = document.getElementById("dc-start-stop");
  const statusDot = document.getElementById("dc-status-dot");
  const statusText = document.getElementById("dc-status-text");
  const clearContextBtn = document.getElementById("dc-clear-context");

  // 可视化配置表单元素
  const dcCfgOwner = document.getElementById("dc-cfg-owner");
  const dcCfgMaxDepth = document.getElementById("dc-cfg-max-depth");
  const dcCfgMaxFetch = document.getElementById("dc-cfg-max-fetch");
  const dcCfgTriggerMention = document.getElementById("dc-cfg-trigger-mention");
  const dcCfgTriggerMessage = document.getElementById("dc-cfg-trigger-message");
  const dcCfgReplyAll = document.getElementById("dc-cfg-reply-all");
  const dcCfgPrivateChat = document.getElementById("dc-cfg-private-chat");
  const dcCfgTriggerChannels = document.getElementById(
    "dc-cfg-trigger-channels",
  );

  // 消息日志元素
  const dcLogStatus = document.getElementById("dc-log-status");
  const dcLogList = document.getElementById("dc-log-list");
  const dcLogEmpty = document.getElementById("dc-log-empty");
  let _dcLogTimer = null;
  let _dcLastLogTs = 0;

  /** 填充可视化配置表单 */
  function populateVisualConfig(cfg) {
    if (dcCfgOwner) dcCfgOwner.value = cfg.OwnerUserName || "";
    if (dcCfgMaxDepth) dcCfgMaxDepth.value = cfg.MaxMessageDepth ?? 20;
    if (dcCfgMaxFetch) dcCfgMaxFetch.value = cfg.MaxFetchCount ?? 30;
    if (dcCfgTriggerMention)
      dcCfgTriggerMention.checked = cfg.TriggerOnMention !== false;
    if (dcCfgTriggerMessage)
      dcCfgTriggerMessage.checked = !!cfg.TriggerOnMessage;
    if (dcCfgReplyAll) dcCfgReplyAll.checked = !!cfg.ReplyToAllMessages;
    if (dcCfgPrivateChat)
      dcCfgPrivateChat.checked = cfg.PrivateChatEnabled !== false;
    if (dcCfgTriggerChannels)
      dcCfgTriggerChannels.value = (cfg.TriggerChannels || []).join(", ");
  }

  /** 从可视化表单读取配置 */
  function readVisualConfig() {
    return {
      OwnerUserName: dcCfgOwner?.value?.trim() || "",
      MaxMessageDepth: parseInt(dcCfgMaxDepth?.value) || 20,
      MaxFetchCount: parseInt(dcCfgMaxFetch?.value) || 30,
      ReplyToAllMessages: !!dcCfgReplyAll?.checked,
      TriggerOnMention: dcCfgTriggerMention?.checked !== false,
      TriggerOnMessage: !!dcCfgTriggerMessage?.checked,
      TriggerChannels: (dcCfgTriggerChannels?.value || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      PrivateChatEnabled: dcCfgPrivateChat?.checked !== false,
    };
  }

  /** HTML 转义 */
  function escapeHtml(str) {
    const d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
  }

  /** 渲染单条日志到消息日志面板 */
  function renderDcLogEntry(entry) {
    const div = document.createElement("div");
    const typeColor =
      entry.type === "user"
        ? "border-info"
        : entry.type === "error"
          ? "border-error"
          : "border-success";
    div.className = `p-1.5 rounded bg-base-300/50 border-l-2 ${typeColor}`;
    const timeStr = new Date(entry.timestamp).toLocaleTimeString();
    const icon =
      entry.type === "user" ? "👤" : entry.type === "error" ? "⚠️" : "🤖";
    let html = `<div class="flex items-center gap-1 opacity-60 text-[10px] mb-0.5">
      <span>${icon}</span>
      <span class="font-semibold">${escapeHtml(entry.author || "")}</span>
      <span>${escapeHtml(entry.channelName || "")}</span>
      <span>${timeStr}</span>
    </div>
    <div class="whitespace-pre-wrap break-words">${escapeHtml((entry.content || "").slice(0, 200))}${(entry.content || "").length > 200 ? "..." : ""}</div>`;
    if (entry.type === "ai" && entry.fullContent) {
      const fid = `dc-full-${entry.id}`;
      html += `<div class="cursor-pointer text-warning text-[10px] mt-0.5 select-none" onclick="document.getElementById('${fid}').classList.toggle('hidden')">📄 展开原始内容</div>
      <div id="${fid}" class="hidden mt-1 p-1 bg-base-100 rounded text-[10px] opacity-80 max-h-40 overflow-y-auto whitespace-pre-wrap">${escapeHtml(entry.fullContent)}</div>`;
    }
    div.innerHTML = html;
    dcLogList?.appendChild(div);
  }

  /** 轮询消息日志 */
  async function pollDcLog() {
    if (!_dcSelectedBot) return;
    try {
      const running = _dcRunningBots.includes(_dcSelectedBot);
      if (dcLogStatus) dcLogStatus.textContent = running ? "运行中" : "未运行";
      if (!running) return;
      const data = await DC_API.getMessageLog(
        _dcSelectedBot,
        _dcLastLogTs || undefined,
      );
      if (data.logs && data.logs.length > 0) {
        for (const entry of data.logs) {
          renderDcLogEntry(entry);
          if (entry.timestamp > _dcLastLogTs) _dcLastLogTs = entry.timestamp;
        }
        if (dcLogEmpty) dcLogEmpty.classList.add("hidden");
        // 自动滚动
        const logContainer = document.getElementById("dc-message-log");
        if (logContainer) logContainer.scrollTop = logContainer.scrollHeight;
      }
    } catch {
      /* 静默 */
    }
  }

  /** 启动日志轮询 */
  function startDcLogPolling() {
    stopDcLogPolling();
    _dcLastLogTs = 0;
    if (dcLogList) dcLogList.innerHTML = "";
    if (dcLogEmpty) dcLogEmpty.classList.remove("hidden");
    pollDcLog();
    _dcLogTimer = setInterval(pollDcLog, 5000);
  }

  /** 停止日志轮询 */
  function stopDcLogPolling() {
    if (_dcLogTimer) {
      clearInterval(_dcLogTimer);
      _dcLogTimer = null;
    }
  }

  if (!botSelect) return;

  // ---- 加载数据 ----
  async function loadBotList() {
    try {
      _dcBotList = await DC_API.getBotList();
      _dcRunningBots = await DC_API.getRunningBotList();
    } catch (err) {
      console.warn("[Discord Bot] 加载 Bot 列表失败:", err.message);
      _dcBotList = [];
      _dcRunningBots = [];
    }
    renderBotSelect();
  }

  function renderBotSelect() {
    botSelect.innerHTML =
      '<option value="" disabled selected>(选择 Bot)</option>';
    _dcBotList.forEach((name) => {
      const opt = document.createElement("option");
      opt.value = name;
      const isRunning = _dcRunningBots.includes(name);
      opt.textContent = name + (isRunning ? " 🟢" : "");
      botSelect.appendChild(opt);
    });

    if (_dcBotList.length === 0) {
      emptyState.classList.remove("hidden");
      if (configCard) configCard.classList.add("hidden");
      deleteBtn.disabled = true;
    } else {
      emptyState.classList.add("hidden");
    }

    if (_dcSelectedBot && _dcBotList.includes(_dcSelectedBot)) {
      botSelect.value = _dcSelectedBot;
    }
  }

  async function loadCharList() {
    if (!charSelect) return;
    try {
      const chars = await getPartList("chars");
      charSelect.innerHTML = '<option value="">(未绑定)</option>';
      chars.forEach((name) => {
        const opt = document.createElement("option");
        opt.value = name;
        opt.textContent = name;
        charSelect.appendChild(opt);
      });
    } catch {
      /* 静默 */
    }
  }

  async function loadBotConfig(botname) {
    _dcSelectedBot = botname;
    deleteBtn.disabled = !botname;

    if (!botname) {
      configCard?.classList.add("hidden");
      updateRunStatus(false);
      return;
    }

    try {
      const config = await DC_API.getBotConfig(botname);
      configCard?.classList.remove("hidden");

      // Token
      if (tokenInput) tokenInput.value = config.token || "";

      // 角色卡
      if (charSelect) charSelect.value = config.char || "";

      // 填充可视化配置表单
      populateVisualConfig(config.config || {});

      // 高级配置 JSON
      if (configJson) {
        try {
          configJson.value = JSON.stringify(config.config || {}, null, 2);
        } catch {
          configJson.value = "{}";
        }
      }

      // 运行状态
      const isRunning = _dcRunningBots.includes(botname);
      updateRunStatus(isRunning);
    } catch (err) {
      showToast(`加载 Bot 配置失败: ${err.message}`, "error");
    }
  }

  function updateRunStatus(isRunning) {
    if (statusDot) {
      statusDot.className = `w-2.5 h-2.5 rounded-full ${isRunning ? "bg-success" : "bg-base-content/20"}`;
    }
    if (statusText) {
      statusText.textContent = isRunning ? "运行中" : "未运行";
      statusText.className = `text-xs ${isRunning ? "text-success" : "text-base-content/50"}`;
    }
    if (startStopBtn) {
      startStopBtn.disabled = !_dcSelectedBot;
      startStopBtn.textContent = isRunning ? "⏹ 停止" : "▶ 启动";
      startStopBtn.className = `btn btn-xs ${isRunning ? "btn-error" : "btn-success"}`;
    }
  }

  // ---- 事件绑定 ----

  // Bot 选择
  botSelect.addEventListener("change", () => {
    loadBotConfig(botSelect.value);
  });

  // 新建 Bot
  async function handleNewBot() {
    const name = prompt("请输入 Bot 名称:");
    if (!name?.trim()) return;
    const trimmed = name.trim();
    if (_dcBotList.includes(trimmed)) {
      showToast(`Bot "${trimmed}" 已存在`, "warning");
      return;
    }
    try {
      await DC_API.newBotConfig(trimmed);
      showToast(`Bot "${trimmed}" 已创建`, "success");
      await loadBotList();
      botSelect.value = trimmed;
      await loadBotConfig(trimmed);
    } catch (err) {
      showToast(`创建失败: ${err.message}`, "error");
    }
  }

  newBtn?.addEventListener("click", handleNewBot);
  emptyNewBtn?.addEventListener("click", handleNewBot);

  // 删除 Bot
  deleteBtn?.addEventListener("click", async () => {
    if (!_dcSelectedBot) return;
    if (!confirm(`确定删除 Bot "${_dcSelectedBot}" 吗？`)) return;
    try {
      // 如果正在运行先停止
      if (_dcRunningBots.includes(_dcSelectedBot)) {
        await DC_API.stopBot(_dcSelectedBot);
      }
      await DC_API.deleteBotConfig(_dcSelectedBot);
      showToast(`Bot "${_dcSelectedBot}" 已删除`, "success");
      _dcSelectedBot = null;
      await loadBotList();
      configCard?.classList.add("hidden");
    } catch (err) {
      showToast(`删除失败: ${err.message}`, "error");
    }
  });

  // 绑定当前角色卡
  bindCurrentBtn?.addEventListener("click", () => {
    const charId = getCurrentCharId();
    if (charId && charSelect) {
      charSelect.value = charId;
      showToast(`已绑定当前角色: ${charId}`, "info");
    } else {
      showToast("当前没有加载角色卡", "warning");
    }
  });

  // Token 显示切换
  tokenToggle?.addEventListener("click", () => {
    if (tokenInput) {
      tokenInput.type = tokenInput.type === "password" ? "text" : "password";
      tokenToggle.textContent = tokenInput.type === "password" ? "👁" : "🙈";
    }
  });

  // 保存配置
  saveBtn?.addEventListener("click", async () => {
    if (!_dcSelectedBot) return;

    let advancedConfig = {};
    if (configJson) {
      try {
        advancedConfig = JSON.parse(configJson.value || "{}");
      } catch (err) {
        showToast("高级配置 JSON 格式错误: " + err.message, "error");
        return;
      }
    }

    // 合并：可视化配置覆盖 JSON 编辑器中的同名字段
    const visualCfg = readVisualConfig();
    const mergedConfig = { ...advancedConfig, ...visualCfg };

    const config = {
      token: tokenInput?.value || "",
      char: charSelect?.value || "",
      config: mergedConfig,
    };

    try {
      await DC_API.setBotConfig(_dcSelectedBot, config);
      if (saveStatus) {
        saveStatus.textContent = "✅ 已保存";
        saveStatus.className = "text-xs text-center text-success";
        saveStatus.classList.remove("hidden");
        setTimeout(() => saveStatus.classList.add("hidden"), 2000);
      }
      showToast("Bot 配置已保存", "success");
    } catch (err) {
      if (saveStatus) {
        saveStatus.textContent = "❌ 保存失败";
        saveStatus.className = "text-xs text-center text-error";
        saveStatus.classList.remove("hidden");
      }
      showToast(`保存失败: ${err.message}`, "error");
    }
  });

  // 启动/停止
  startStopBtn?.addEventListener("click", async () => {
    if (!_dcSelectedBot) return;
    startStopBtn.disabled = true;

    try {
      const isRunning = _dcRunningBots.includes(_dcSelectedBot);
      if (isRunning) {
        await DC_API.stopBot(_dcSelectedBot);
        showToast(`Bot "${_dcSelectedBot}" 已停止`, "info");
      } else {
        await DC_API.startBot(_dcSelectedBot);
        showToast(`Bot "${_dcSelectedBot}" 已启动`, "success");
      }
      // 刷新运行状态
      _dcRunningBots = await DC_API.getRunningBotList();
      updateRunStatus(_dcRunningBots.includes(_dcSelectedBot));
      renderBotSelect();
    } catch (err) {
      showToast(`操作失败: ${err.message}`, "error");
    } finally {
      startStopBtn.disabled = false;
    }
  });

  // 角色卡选择变化 → 加载配置模板
  charSelect?.addEventListener("change", async () => {
    const charName = charSelect.value;
    if (!charName) return;
    try {
      const template = await DC_API.getBotConfigTemplate(charName);
      if (template && Object.keys(template).length > 0) {
        populateVisualConfig(template);
        if (configJson) configJson.value = JSON.stringify(template, null, 2);
      }
    } catch {
      /* 静默 */
    }
  });

  // INJ-3 编辑按钮 → 切换到注入提示词面板
  const dcEditInj3 = document.getElementById("dc-edit-inj3");
  dcEditInj3?.addEventListener("click", () => {
    // 切换到右栏注入提示词折叠组
    const injSection = document.getElementById("right-section-injection");
    if (injSection) {
      // 展开注入提示词折叠组
      const collapseInput = injSection.querySelector('input[type="checkbox"]');
      if (collapseInput && !collapseInput.checked) collapseInput.checked = true;
      injSection.scrollIntoView({ behavior: "smooth", block: "start" });
      showToast("请在右栏找到 INJ-3 Discord Bot 提示词进行编辑", "info");
    } else {
      showToast("请在右栏 → 注入提示词 中找到 INJ-3 进行编辑", "info");
    }
  });

  // 清除上下文
  clearContextBtn?.addEventListener("click", async () => {
    if (!_dcSelectedBot) return;
    if (!confirm("确定要清除所有频道的聊天上下文吗？\n（记忆表格将保留）"))
      return;
    clearContextBtn.disabled = true;
    try {
      const result = await DC_API.clearContext(_dcSelectedBot);
      showToast(
        `上下文已清除（${result.clearedChannels || 0} 个频道）`,
        "success",
      );
      // 重置消息日志
      _dcLastLogTs = 0;
      if (dcLogList) dcLogList.innerHTML = "";
      if (dcLogEmpty) dcLogEmpty.classList.remove("hidden");
    } catch (err) {
      showToast(`清除失败: ${err.message}`, "error");
    } finally {
      clearContextBtn.disabled = false;
    }
  });

  // ---- 初始加载 ----
  await loadCharList();
  await loadBotList();

  // 自动选择第一个 Bot
  if (_dcBotList.length > 0) {
    botSelect.value = _dcBotList[0];
    await loadBotConfig(_dcBotList[0]);
  }

  // 启动日志轮询
  startDcLogPolling();

  // 定期刷新运行状态（每 10 秒）
  setInterval(async () => {
    // 只在 Bot 面板可见时刷新
    const botPanel = document.getElementById("center-tab-bot");
    if (!botPanel || botPanel.classList.contains("hidden")) return;
    try {
      _dcRunningBots = await DC_API.getRunningBotList();
      if (_dcSelectedBot) {
        updateRunStatus(_dcRunningBots.includes(_dcSelectedBot));
      }
    } catch {
      /* 静默 */
    }
  }, 10000);

  console.log("[beilu-chat] Discord Bot 面板已初始化");
}

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
  const addBtn = document.getElementById("injection-prompt-add");
  const editorEl = document.getElementById("injection-prompt-editor");
  const editId = document.getElementById("inj-edit-id");
  const editName = document.getElementById("inj-edit-name");
  const editRole = document.getElementById("inj-edit-role");
  const editDepth = document.getElementById("inj-edit-depth");
  const editAutoMode = document.getElementById("inj-edit-automode");
  const editContent = document.getElementById("inj-edit-content");
  const editSaveBtn = document.getElementById("inj-edit-save");
  const editCancelBtn = document.getElementById("inj-edit-cancel");
  if (!listEl) return;

  const MEMORY_API_SET = "/api/parts/plugins:beilu-memory/config/setdata";

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
      const params = new URLSearchParams();
      if (charId) params.set("char_id", charId);
      const resp = await fetch(
        `/api/parts/plugins:beilu-memory/config/getdata?${params}`,
      );
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      _injPrompts = data.injection_prompts || [];

      // F-C: 从角色卡 chardata 获取 depth_prompt（角色卡层注入提示词）
      _charDepthPrompt = null;
      if (charId) {
        try {
          const charResp = await fetch(
            `/api/parts/shells:beilu-home/char-data/${encodeURIComponent(charId)}`,
          );
          if (charResp.ok) {
            const charData = await charResp.json();
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
      listEl.innerHTML =
        '<p class="text-xs text-base-content/40 text-center py-2">暂无注入提示词</p>';
      return;
    }

    listEl.innerHTML = "";
    prompts.forEach((p) => {
      const item = document.createElement("div");
      const isFromChar = p._fromCharData === true;
      item.className =
        "flex items-center gap-1.5 py-1 px-1 rounded text-xs hover:bg-base-300/30 cursor-pointer group" +
        (isFromChar ? " border-l-2 border-amber-500/50" : "");
      item.dataset.injId = p.id;

      const deletable = p.deletable === true && !isFromChar;
      item.innerHTML = `
    <input type="checkbox" class="checkbox checkbox-xs checkbox-success inj-toggle"
    	data-inj-id="${escapeHtml(p.id)}" ${p.enabled ? "checked" : ""} ${isFromChar ? "disabled" : ""} title="${isFromChar ? "由角色卡定义，始终启用" : "启用/禁用"}" />
    <span class="flex-1 truncate inj-name-label">${escapeHtml(p.name || p.id)}</span>
    ${isFromChar ? '<span class="badge badge-xs badge-warning" title="来自角色卡 chardata">角色卡</span>' : ""}
    <span class="badge badge-xs opacity-40">${escapeHtml(p.role || "system")}</span>
    ${deletable ? `<button class="btn btn-ghost btn-xs opacity-0 group-hover:opacity-60 inj-delete-btn" data-inj-id="${escapeHtml(p.id)}" title="删除">🗑️</button>` : ""}
   `;

      // 点击条目 → 展开编辑面板
      item.addEventListener("click", (e) => {
        if (
          e.target.classList.contains("inj-toggle") ||
          e.target.classList.contains("inj-delete-btn")
        )
          return;
        openEditor(p);
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
          await deleteInjPrompt(p.id, p.name || p.id);
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
      const resp = await fetch(MEMORY_API_SET, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          _action: "updateInjectionPrompt",
          injectionId: injId,
          enabled,
          charName: charId || "_global",
        }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      // 更新本地缓存
      const p = _injPrompts.find((x) => x.id === injId);
      if (p) p.enabled = enabled;

      // 同步 INJ-2 状态缓存（如果切换的是 INJ-2）
      if (injId === "INJ-2") {
        _inj2Enabled = enabled;
        const statusEl = document.getElementById("inj2-status");
        if (statusEl) statusEl.textContent = enabled ? "ON" : "OFF";
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
  async function deleteInjPrompt(injId, displayName) {
    if (!confirm(`确定删除注入提示词 "${displayName}" 吗？`)) return;
    const charId = getCurrentCharId();
    try {
      const resp = await fetch(MEMORY_API_SET, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          _action: "deleteInjectionPrompt",
          injectionId: injId,
          charName: charId || "_global",
        }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const result = await resp.json();
      if (result.error) throw new Error(result.error);
      showToast(`已删除: ${displayName}`, "success");
      // 如果编辑面板正在编辑此条目，关闭面板
      if (editorEl && editId?.value === injId) closeEditor();
      await loadList();
    } catch (err) {
      showToast(`删除失败: ${err.message}`, "error");
    }
  }

  /**
   * 打开编辑面板，填充表单数据
   * @param {object} p - 注入提示词对象
   */
  function openEditor(p) {
    if (!editorEl) return;
    const isFromChar = p._fromCharData === true;
    editId.value = p.id;
    editName.value = p.name || "";
    editRole.value = p.role || "system";
    editDepth.value = p.depth ?? 0;
    editAutoMode.value = p.autoMode || "none";
    editContent.value = p.content || p.content_preview || "";
    editorEl.classList.remove("hidden");

    // F-C: 角色卡来源条目 → 编辑面板只读
    if (editName) editName.readOnly = isFromChar;
    if (editRole) editRole.disabled = isFromChar;
    if (editDepth) editDepth.readOnly = isFromChar;
    if (editAutoMode) editAutoMode.disabled = isFromChar;
    if (editContent) editContent.readOnly = isFromChar;
    if (editSaveBtn) {
      if (isFromChar) {
        editSaveBtn.classList.add("hidden");
      } else {
        editSaveBtn.classList.remove("hidden");
      }
    }

    // 高亮当前条目
    listEl.querySelectorAll("[data-inj-id]").forEach((el) => {
      el.classList.toggle("ring-1", el.dataset.injId === p.id);
      el.classList.toggle("ring-amber-500", el.dataset.injId === p.id);
    });
  }

  /**
   * 关闭编辑面板
   */
  function closeEditor() {
    if (!editorEl) return;
    editorEl.classList.add("hidden");
    editId.value = "";
    // 取消高亮
    listEl.querySelectorAll("[data-inj-id]").forEach((el) => {
      el.classList.remove("ring-1", "ring-amber-500");
    });
  }

  // 编辑面板 — 保存按钮
  editSaveBtn?.addEventListener("click", async () => {
    const injId = editId?.value;
    if (!injId) return;
    const charId = getCurrentCharId();
    try {
      const resp = await fetch(MEMORY_API_SET, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          _action: "updateInjectionPrompt",
          injectionId: injId,
          charName: charId || "_global",
          name: editName.value,
          role: editRole.value,
          depth: parseInt(editDepth.value) || 0,
          autoMode: editAutoMode.value,
          content: editContent.value,
        }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      showToast("注入提示词已保存", "success");
      closeEditor();
      await loadList();
    } catch (err) {
      showToast(`保存失败: ${err.message}`, "error");
    }
  });

  // 编辑面板 — 取消按钮
  editCancelBtn?.addEventListener("click", closeEditor);

  // 添加按钮
  addBtn?.addEventListener("click", async () => {
    const charId = getCurrentCharId();
    try {
      const resp = await fetch(MEMORY_API_SET, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          _action: "addInjectionPrompt",
          charName: charId || "_global",
          name: "新注入提示词",
          content: "",
          role: "system",
          depth: 0,
        }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const result = await resp.json();
      if (result.error) throw new Error(result.error);
      showToast("已添加新注入提示词", "success");
      await loadList();
      // 自动打开编辑面板
      if (result.injection) openEditor(result.injection);
    } catch (err) {
      showToast(`添加失败: ${err.message}`, "error");
    }
  });

  // 初始加载
  await loadList();
  refreshBtn?.addEventListener("click", loadList);
}

// ============================================================
// 图片压缩工具 — Canvas API 压缩 base64 图片
// ============================================================

/** 5MB 字节数阈值（Claude API 限制） */
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/**
 * 压缩 base64 图片（截图不需要高清晰度，无论大小都先压缩一次）
 * 压缩策略：
 *   1. < 1MB 的 JPEG 不压缩（已经足够小）
 *   2. 其他：先转 JPEG quality=0.7
 *   3. 仍超 5MB → quality=0.4
 *   4. 仍超 → 分辨率减半 + quality=0.2
 * @param {string} base64Str - 不含 data:xxx;base64, 前缀的 base64 字符串
 * @param {string} mimeType - 原始 MIME 类型（如 image/png）
 * @param {number} [maxBytes=5242880] - 最大字节数
 * @returns {Promise<{base64: string, mimeType: string, compressed: boolean}>}
 */
async function compressImageBase64(
  base64Str,
  mimeType,
  maxBytes = IMAGE_MAX_BYTES,
) {
  // 估算原始字节数：base64 编码后大小 ≈ 原始 * 4/3
  const estimatedBytes = Math.ceil((base64Str.length * 3) / 4);

  // < 1MB 的 JPEG 不压缩（已经足够小，避免无意义的重编码）
  if (estimatedBytes < 1024 * 1024 && mimeType === "image/jpeg") {
    return { base64: base64Str, mimeType, compressed: false };
  }

  console.log(
    `[beilu-chat] 截图大小 ${(estimatedBytes / 1024 / 1024).toFixed(2)}MB，开始压缩...`,
  );

  // 加载图片到 Image 对象
  const img = await new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片加载失败"));
    image.src = `data:${mimeType};base64,${base64Str}`;
  });

  // 用 Canvas 重编码
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);

  // 第一次压缩：JPEG quality=0.7（PNG→JPEG 通常压缩 70-80%）
  let compressedDataUrl = canvas.toDataURL("image/jpeg", 0.7);
  let compressedBase64 = compressedDataUrl.split(",")[1];
  let compressedBytes = Math.ceil((compressedBase64.length * 3) / 4);
  console.log(
    `[beilu-chat] 第一次压缩(quality=0.7): ${(compressedBytes / 1024 / 1024).toFixed(2)}MB`,
  );

  if (compressedBytes <= maxBytes) {
    return {
      base64: compressedBase64,
      mimeType: "image/jpeg",
      compressed: true,
    };
  }

  // 第二次压缩：JPEG quality=0.4
  compressedDataUrl = canvas.toDataURL("image/jpeg", 0.4);
  compressedBase64 = compressedDataUrl.split(",")[1];
  compressedBytes = Math.ceil((compressedBase64.length * 3) / 4);
  console.log(
    `[beilu-chat] 第二次压缩(quality=0.4): ${(compressedBytes / 1024 / 1024).toFixed(2)}MB`,
  );

  if (compressedBytes <= maxBytes) {
    return {
      base64: compressedBase64,
      mimeType: "image/jpeg",
      compressed: true,
    };
  }

  // 最后手段：缩小分辨率到原来的 50% + quality=0.2
  console.warn(
    `[beilu-chat] 压缩后仍超过限制 (${(compressedBytes / 1024 / 1024).toFixed(2)}MB)，缩小分辨率...`,
  );
  canvas.width = Math.floor(img.width / 2);
  canvas.height = Math.floor(img.height / 2);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  compressedDataUrl = canvas.toDataURL("image/jpeg", 0.2);
  compressedBase64 = compressedDataUrl.split(",")[1];
  compressedBytes = Math.ceil((compressedBase64.length * 3) / 4);
  console.log(
    `[beilu-chat] 缩小分辨率后: ${(compressedBytes / 1024 / 1024).toFixed(2)}MB (${canvas.width}x${canvas.height})`,
  );

  return { base64: compressedBase64, mimeType: "image/jpeg", compressed: true };
}

// ============================================================
// 贝露的眼睛 — 桌面截图主动发送轮询
// ============================================================

/** 轮询定时器 */
let _eyePollTimer = null;
/** 防止重复发送的冷却时间戳 */
let _eyeCooldownUntil = 0;

/**
 * 启动桌面截图主动发送轮询
 * 每2秒检查 /api/eye/status，如果有 mode=active 的待注入截图，
 * 自动调用 addUserReply 发送消息触发 AI 回复
 */
function startEyeActivePoll() {
  if (_eyePollTimer) return;
  _eyePollTimer = setInterval(pollEyeStatus, 2000);
  console.log("[beilu-chat] 贝露的眼睛主动发送轮询已启动");
}

async function pollEyeStatus() {
  // 冷却期内跳过
  if (Date.now() < _eyeCooldownUntil) return;
  try {
    const resp = await fetch("/api/eye/status");
    if (!resp.ok) return;
    const data = await resp.json();
    if (data.hasPending && data.mode === "active") {
      // 设置20秒冷却（消费 + AI 生成需要时间）
      _eyeCooldownUntil = Date.now() + 20000;
      console.log(
        "[beilu-chat] 检测到桌面截图（主动发送模式），获取截图数据...",
      );
      try {
        // 消费截图数据（获取 base64 并清除 pending）
        const consumeResp = await fetch("/api/eye/consume", { method: "POST" });
        if (!consumeResp.ok) {
          console.error("[beilu-chat] 消费截图数据失败:", consumeResp.status);
          _eyeCooldownUntil = Date.now() + 3000;
          return;
        }
        const eyeData = await consumeResp.json();
        if (!eyeData.success || !eyeData.image) {
          console.warn("[beilu-chat] 截图数据为空或已被消费");
          _eyeCooldownUntil = Date.now() + 3000;
          return;
        }

        // 根据 base64 数据头判断图片格式（PNG 以 iVBOR 开头，JPEG 以 /9j/ 开头）
        const isJpeg = eyeData.image.startsWith("/9j/");
        let imgMimeType = isJpeg ? "image/jpeg" : "image/png";
        let imgBase64 = eyeData.image;

        // ★ 压缩检查：超过 5MB 的图片先压缩，避免 Claude API 拒绝
        try {
          const compressed = await compressImageBase64(imgBase64, imgMimeType);
          imgBase64 = compressed.base64;
          imgMimeType = compressed.mimeType;
          if (compressed.compressed) {
            console.log(`[beilu-chat] 截图已压缩为 ${imgMimeType}`);
          }
        } catch (compressErr) {
          console.warn(
            "[beilu-chat] 截图压缩失败，使用原始图片:",
            compressErr.message,
          );
        }

        const imgExt = imgMimeType === "image/jpeg" ? "jpg" : "png";

        // 将截图 base64 作为 files 发送（与浏览器上传完全相同的路径）
        const screenshotFile = {
          name: `desktop_screenshot_${Date.now()}.${imgExt}`,
          mime_type: imgMimeType,
          buffer: imgBase64, // base64 字符串（不含 data:xxx;base64, 前缀）
          description: "桌面截图",
        };
        // ★ 截图消息使用特殊前缀标记，前端通过 CSS 隐藏该用户消息（视觉上不显示）
        // 但技术上仍通过 addUserReply(files) 发送，因为 AI 需要 files 路径才能看到图片
        const message = eyeData.message || "[beilu-eye-screenshot]";
        const taggedMessage = message.startsWith("[beilu-eye-screenshot]")
          ? message
          : `[beilu-eye-screenshot] ${message}`;
        await addUserReply({ content: taggedMessage, files: [screenshotFile] });
        console.log(
          "[beilu-chat] 截图消息已发送（含图片文件，聊天界面已隐藏），后端自动触发AI回复",
        );
      } catch (err) {
        console.error("[beilu-chat] 截图消息发送失败:", err);
        _eyeCooldownUntil = Date.now() + 3000;
      }
    }
  } catch {
    // 静默失败（后端可能未启动）
  }
}

// ============================================================
// 浏览器感知 — 主动发送轮询
// ============================================================

/** 浏览器感知轮询定时器 */
let _browserPollTimer = null;
/** 防止重复发送的冷却时间戳 */
let _browserCooldownUntil = 0;

const BROWSER_API_GET = "/api/parts/plugins:beilu-browser/config/getdata";
const BROWSER_API_SET = "/api/parts/plugins:beilu-browser/config/setdata";

/**
 * 启动浏览器感知主动发送轮询
 * 每3秒检查 beilu-browser GetData，如果有 hasPending，
 * 自动消费并调用 addUserReply 发送消息触发 AI 回复
 */
function startBrowserActivePoll() {
  if (_browserPollTimer) return;
  _browserPollTimer = setInterval(pollBrowserStatus, 3000);
  console.log("[beilu-chat] 浏览器感知主动发送轮询已启动");
}

async function pollBrowserStatus() {
  // 冷却期内跳过
  if (Date.now() < _browserCooldownUntil) return;
  try {
    const resp = await fetch(BROWSER_API_GET);
    if (!resp.ok) return;
    const data = await resp.json();
    if (data.hasPending) {
      // 设置20秒冷却（消费 + AI 生成需要时间）
      _browserCooldownUntil = Date.now() + 20000;
      console.log("[beilu-chat] 检测到浏览器页面（临时注入模式），消费数据...");
      try {
        // 消费 pending 数据 — 后端 consumeBrowser 会同时将内容存入一次性 GetPrompt 注入缓存
        const consumeResp = await fetch(BROWSER_API_SET, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ _action: "consumeBrowser" }),
        });
        if (!consumeResp.ok) {
          console.error("[beilu-chat] 消费浏览器数据失败:", consumeResp.status);
          _browserCooldownUntil = Date.now() + 3000;
          return;
        }
        const browserData = await consumeResp.json();
        if (!browserData.success) {
          console.warn("[beilu-chat] 浏览器数据为空或已被消费");
          _browserCooldownUntil = Date.now() + 3000;
          return;
        }

        // ★ 双通道模式：
        // 1. addUserReply 发送带标记的用户消息（让 {{lastUserMessage}} 宏能捕获）
        // 2. 页面完整内容通过后端 GetPrompt 一次性注入 AI 上下文（consumeBrowser 已存入缓存）
        // 用户消息前端默认隐藏（messageList.mjs 中过滤 [beilu-browser-page] 前缀）
        const title = browserData.title || "未知页面";
        const url = browserData.url || "";
        const userMessage = browserData.message
          ? `[beilu-browser-page] ${browserData.message}`
          : `[beilu-browser-page] 我正在浏览: ${title}${url ? " (" + url + ")" : ""}`;
        await addUserReply({ content: userMessage });
        console.log(
          "[beilu-chat] 浏览器感知用户消息已发送（双通道模式），页面内容通过 GetPrompt 注入",
          "| 页面:",
          title,
        );
      } catch (err) {
        console.error("[beilu-chat] 浏览器感知触发失败:", err);
        _browserCooldownUntil = Date.now() + 3000;
      }
    }
  } catch {
    // 静默失败（插件可能未加载）
  }
}

// ============================================================
// 文件操作结果闭环 — 自动继续轮询
// ============================================================

/** 文件操作结果轮询定时器 */
let _fileOpPollTimer = null;
/** 防止重复发送的冷却时间戳 */
let _fileOpCooldownUntil = 0;

/**
 * 启动文件操作结果自动继续轮询
 * 每3秒检查 beilu-files 是否有待注入的操作结果，
 * 如果有且自动继续开关已启用且当前处于文件模式，
 * 自动调用 addUserReply 发送消息触发 AI 继续回复
 */
function startFileOpResultPoll() {
  if (_fileOpPollTimer) return;
  _fileOpPollTimer = setInterval(pollFileOpResults, 3000);
  console.log("[beilu-chat] 文件操作结果自动继续轮询已启动");
}

async function pollFileOpResults() {
  // 冷却期内跳过
  if (Date.now() < _fileOpCooldownUntil) return;

  // 检查是否在文件模式（通过顶部选项卡判断）
  const activeTabBtn = document.querySelector("[data-top-tab].top-tab-active");
  if (activeTabBtn?.dataset?.topTab !== "files") return;

  // 检查自动继续开关是否启用
  const autoContinueToggle = document.getElementById("ide-auto-continue");
  if (!autoContinueToggle?.checked) return;

  try {
    // 只检查是否有待注入的结果（不消费，由 GetPrompt 消费）
    const res = await fetch("/api/parts/plugins:beilu-files/config/setdata", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ _action: "getPendingOpResults" }),
    });
    if (!res.ok) return;
    const data = await res.json();

    if (data.hasPending && data.count > 0) {
      // 设置冷却时间（AI 生成回复需要时间，避免重复触发）
      _fileOpCooldownUntil = Date.now() + 20000;
      console.log(
        `[beilu-chat] 检测到 ${data.count} 条待注入的文件操作结果，触发 AI 继续...`,
      );

      try {
        // 使用 triggerCharacterReply 触发 AI 回复（不发送用户消息）
        // 操作结果通过 GetPrompt → AddSystemPrompt 以系统提示注入
        const charId = getCurrentCharId();
        if (charId) {
          await triggerCharacterReply(charId);
          console.log(
            "[beilu-chat] 已触发 AI 继续，操作结果将通过系统提示注入",
          );
        }
      } catch (err) {
        console.error("[beilu-chat] 触发 AI 继续失败:", err);
        // 触发失败时缩短冷却时间以便重试
        _fileOpCooldownUntil = Date.now() + 5000;
      }
    }
  } catch {
    // 静默失败（插件可能未加载）
  }
}

// ============================================================
// 角色卡脚本系统（tavern_helper 脚本 iframe）
// ============================================================

/**
 * 初始化角色卡脚本系统
 * 从当前角色卡中提取 tavern_helper.scripts 并在隐藏 iframe 中执行
 */
async function initCharacterScriptSystem() {
  const charId = getCurrentCharId();
  if (!charId) {
    // charList 可能还没加载好，延迟重试
    const retryTimer = setInterval(async () => {
      const id = getCurrentCharId();
      if (id) {
        clearInterval(retryTimer);
        await _loadScriptsForChar(id);
      }
    }, 2000);
    setTimeout(() => clearInterval(retryTimer), 30000);
    return;
  }
  await _loadScriptsForChar(charId);
}

/**
 * 为指定角色卡加载脚本
 * @param {string} charId - 角色卡 ID
 */
async function _loadScriptsForChar(charId) {
  // 角色隔离：更新变量存储上下文，切换到该角色的 character 变量空间
  try {
    updateVarContext({ charId, chatId: currentChatId || "" });
  } catch (e) {
    console.warn("[beilu-chat] updateVarContext 失败（非致命）:", e.message);
  }

  try {
    // 通过 beilu-home 的 char-data API 获取完整 chardata.json
    // 不能用 getPartDetails()，因为它只返回展示信息（name/avatar/description），不含 chardata
    const resp = await fetch(
      `/api/parts/shells:beilu-home/char-data/${encodeURIComponent(charId)}`,
    );
    if (!resp.ok) {
      console.warn(
        `[beilu-chat] 获取角色卡数据失败: ${charId} (HTTP ${resp.status})`,
      );
      return;
    }
    const charData = await resp.json();
    if (!charData || typeof charData !== "object") return;

    const charName = charData.name || charId;
    const userName = personaName || "User";

    // 获取当前聊天消息队列，传入脚本 iframe 用于 SillyTavern.chat 初始化
    // MVU variable_init 需要 chat 数组非空才能进行变量初始化
    let chatMessages = [];
    try {
      chatMessages = getQueue();
      // 如果 queue 还没有数据（virtualList 异步加载中），等待一段时间重试
      if (!chatMessages || chatMessages.length === 0) {
        for (let retry = 0; retry < 5; retry++) {
          await new Promise((r) => setTimeout(r, 1000));
          chatMessages = getQueue();
          if (chatMessages && chatMessages.length > 0) break;
        }
      }
      // ★ 修复：如果 getQueue() 始终为空（virtualList 时序问题），
      // 直接从后端 API 获取 chatLog 作为 fallback
      if (!chatMessages || chatMessages.length === 0) {
        console.warn(
          "[beilu-chat] getQueue() 仍为空，尝试从后端 API 获取 chatLog...",
        );
        try {
          const { getChatLog, getChatLogLength } =
            await import("./src/endpoints.mjs");
          const logLen = await getChatLogLength();
          if (logLen > 0) {
            chatMessages = await getChatLog(0, logLen);
            console.log(
              `[beilu-chat] 从后端 API 获取到 ${chatMessages.length} 条消息（fallback）`,
            );
          }
        } catch (apiErr) {
          console.warn(
            "[beilu-chat] 后端 API fallback 也失败:",
            apiErr.message,
          );
        }
      }
      console.log(
        `[beilu-chat] chatMessages for script system: ${chatMessages?.length || 0} messages`,
      );
    } catch (e) {
      console.warn(
        "[beilu-chat] getQueue failed for script system:",
        e.message,
      );
    }

    await loadCharacterScripts(charData, {
      userName,
      charName,
      charId,
      chatId: currentChatId || "",
      chatMessages,
    });
    console.log(`[beilu-chat] 角色卡脚本系统已加载: ${charId}`);
  } catch (err) {
    console.warn(`[beilu-chat] 加载角色卡脚本失败: ${charId}`, err.message);
  }
}

init();

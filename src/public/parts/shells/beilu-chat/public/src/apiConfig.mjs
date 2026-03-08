/**
 * API 配置管理模块
 *
 * 在 beilu-chat 管理面板中提供简化的 API 服务源配置表单，
 * 复用 serviceSourceManage 后端 API，无需自定义后端路由。
 */

import { charList } from "./chat.mjs";

const API_BASE = "/api/parts/shells:serviceSourceManage";
const SERVICE_TYPE = "AI";

// ============================================================
// API 通信层
// ============================================================

async function fetchApiList() {
  const res = await fetch(`${API_BASE}/${SERVICE_TYPE}`);
  if (!res.ok) throw new Error(`获取列表失败: ${res.statusText}`);
  return res.json();
}

async function fetchApiConfig(name) {
  const res = await fetch(
    `${API_BASE}/${SERVICE_TYPE}/${encodeURIComponent(name)}`,
  );
  if (!res.ok) throw new Error(`获取配置失败: ${res.statusText}`);
  return res.json();
}

async function saveApiSource(name, data) {
  const res = await fetch(
    `${API_BASE}/${SERVICE_TYPE}/${encodeURIComponent(name)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    },
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `保存失败: ${res.statusText}`);
  }
  return res.json();
}

async function deleteApiSource(name) {
  const res = await fetch(
    `${API_BASE}/${SERVICE_TYPE}/${encodeURIComponent(name)}`,
    {
      method: "DELETE",
    },
  );
  if (!res.ok) throw new Error(`删除失败: ${res.statusText}`);
  return res.json();
}

async function fetchConfigTemplate(generator) {
  const res = await fetch(
    `${API_BASE}/${SERVICE_TYPE}/generators/${encodeURIComponent(generator)}/template`,
  );
  if (!res.ok) throw new Error(`获取模板失败: ${res.statusText}`);
  return res.json();
}

// ============================================================
// API 类型定义
// ============================================================

const API_TYPES = {
  openai: {
    label: "OpenAI",
    generator: "proxy",
    urlField: "url",
    urlPlaceholder: "https://api.openai.com/v1/chat/completions",
    urlLabel: "API URL（完整端点地址）",
    defaultModel: "gpt-4o-mini",
  },
  deepseek: {
    label: "DeepSeek",
    generator: "proxy",
    urlField: "url",
    urlPlaceholder: "https://api.deepseek.com/v1/chat/completions",
    urlLabel: "API URL（完整端点地址）",
    defaultModel: "deepseek-chat",
  },
  proxy: {
    label: "OpenAI 兼容（自定义）",
    generator: "proxy",
    urlField: "url",
    urlPlaceholder: "https://api.openai.com/v1/chat/completions",
    urlLabel: "API URL（完整端点地址）",
  },
  gemini: {
    label: "Google Gemini",
    generator: "gemini",
    urlField: "base_url",
    urlPlaceholder: "https://generativelanguage.googleapis.com",
    urlLabel: "Base URL（留空使用默认）",
  },
};

/**
 * 根据已保存的 generator + config 推断 UI 显示的 API 类型
 * 例如 generator=proxy 但 url 包含 deepseek → 显示为 deepseek
 */
function inferApiType(generator, config) {
  if (generator === "gemini") return "gemini";
  if (generator !== "proxy")
    return generator in API_TYPES ? generator : "proxy";
  const url = (config?.url || "").toLowerCase();
  const model = (config?.model || "").toLowerCase();
  if (url.includes("deepseek") || model.includes("deepseek")) return "deepseek";
  if (url.includes("openai.com")) return "openai";
  return "proxy";
}

// ============================================================
// 状态
// ============================================================

const STORAGE_KEY = "beilu_current_api_source";

let currentApiName = null;
let apiSources = [];

// ============================================================
// DOM 引用
// ============================================================

let apiSelect,
  apiNameInput,
  apiTypeSelect,
  apiUrlInput,
  apiKeyInput,
  apiModelInput;
let apiSaveBtn, apiDeleteBtn, apiNewBtn, apiStatus;

// ============================================================
// 初始化（绑定 DOM 和事件，只调用一次）
// ============================================================

export function initApiConfig() {
  apiSelect = document.getElementById("api-select");
  apiNameInput = document.getElementById("api-name");
  apiTypeSelect = document.getElementById("api-type");
  apiUrlInput = document.getElementById("api-url");
  apiKeyInput = document.getElementById("api-key");
  apiModelInput = document.getElementById("api-model");
  apiSaveBtn = document.getElementById("api-save-btn");
  apiDeleteBtn = document.getElementById("api-delete-btn");
  apiNewBtn = document.getElementById("api-new-btn");
  apiStatus = document.getElementById("api-status");

  apiSelect?.addEventListener("change", async () => {
    await loadApiSource(apiSelect.value);
    // 自动同步角色卡绑定：切换 API 源时，更新当前聊天所有角色的 AIsource
    await syncCharAIsource(apiSelect.value);
  });
  // API 类型切换时，传入旧类型以便自动更新 URL
  let _lastApiType = apiTypeSelect?.value || "proxy";
  apiTypeSelect?.addEventListener("change", () => {
    const oldType = _lastApiType;
    _lastApiType = apiTypeSelect.value;
    syncUrlLabel(oldType);
  });
  apiSaveBtn?.addEventListener("click", handleSave);
  apiDeleteBtn?.addEventListener("click", handleDelete);
  apiNewBtn?.addEventListener("click", handleNew);
}

// ============================================================
// 加载（切换到 API 选项卡时调用）
// ============================================================

export async function loadApiConfig() {
  if (!apiSelect) return;
  try {
    const list = await fetchApiList();
    apiSources = list;
    renderApiSelect(list);
    if (list.length > 0) {
      // 优先使用 localStorage 中保存的上次选择
      const saved = localStorage.getItem(STORAGE_KEY);
      const defaultName =
        saved && list.includes(saved)
          ? saved
          : currentApiName && list.includes(currentApiName)
            ? currentApiName
            : list[0];
      await loadApiSource(defaultName);
    } else {
      clearForm();
    }
  } catch (err) {
    console.error("[beilu-chat] 加载 API 配置列表失败:", err);
    showApiStatus("加载失败: " + err.message, "error");
  }
}

// ============================================================
// 渲染
// ============================================================

function renderApiSelect(list) {
  if (!apiSelect) return;
  apiSelect.innerHTML = "";
  if (list.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "（无配置）";
    apiSelect.appendChild(opt);
    return;
  }
  list.forEach((name) => {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    if (name === currentApiName) opt.selected = true;
    apiSelect.appendChild(opt);
  });
}

function clearForm() {
  currentApiName = null;
  if (apiNameInput) apiNameInput.value = "";
  if (apiTypeSelect) apiTypeSelect.value = "proxy";
  if (apiUrlInput) apiUrlInput.value = "";
  if (apiKeyInput) apiKeyInput.value = "";
  if (apiModelInput) apiModelInput.value = "";
  if (apiDeleteBtn) apiDeleteBtn.disabled = true;
  syncUrlLabel();
}

function syncUrlLabel(oldType) {
  const type = apiTypeSelect?.value || "proxy";
  const typeInfo = API_TYPES[type] || API_TYPES.proxy;
  const label = document.getElementById("api-url-label");
  if (label) label.textContent = typeInfo.urlLabel;
  if (apiUrlInput) {
    // 如果 URL 为空或等于旧类型的默认 URL，自动填入新类型的默认 URL
    const oldTypeInfo = oldType ? API_TYPES[oldType] || API_TYPES.proxy : null;
    const currentUrl = apiUrlInput.value.trim();
    if (
      !currentUrl ||
      (oldTypeInfo && currentUrl === oldTypeInfo.urlPlaceholder)
    ) {
      apiUrlInput.value = typeInfo.urlPlaceholder;
    }
    apiUrlInput.placeholder = typeInfo.urlPlaceholder;
  }
  // 如果模型为空且该类型有默认模型，自动填入
  if (apiModelInput && !apiModelInput.value.trim() && typeInfo.defaultModel) {
    apiModelInput.value = typeInfo.defaultModel;
  }
}

// ============================================================
// 加载单个配置
// ============================================================

async function loadApiSource(name) {
  if (!name) return;
  currentApiName = name;
  localStorage.setItem(STORAGE_KEY, name);
  if (apiSelect) apiSelect.value = name;
  try {
    const data = await fetchApiConfig(name);
    const generator = data.generator || "proxy";
    const config = data.config || {};

    if (apiNameInput) apiNameInput.value = config.name || name;
    // 用 inferApiType 推断 UI 显示类型（例如 proxy+deepseek URL → deepseek）
    const uiType = inferApiType(generator, config);
    if (apiTypeSelect) apiTypeSelect.value = uiType;

    const typeInfo = API_TYPES[uiType] || API_TYPES.proxy;
    if (apiUrlInput) apiUrlInput.value = config[typeInfo.urlField] || "";
    if (apiKeyInput) apiKeyInput.value = config.apikey || "";
    if (apiModelInput) apiModelInput.value = config.model || "";

    syncUrlLabel();
    if (apiDeleteBtn) apiDeleteBtn.disabled = false;
  } catch (err) {
    console.error("[beilu-chat] 加载 API 配置失败:", err);
    showApiStatus("加载失败: " + err.message, "error");
  }
}

// ============================================================
// 保存
// ============================================================

async function handleSave() {
  if (!currentApiName) {
    showApiStatus("请先选择或新建一个配置", "error");
    return;
  }
  const uiType = apiTypeSelect?.value || "proxy";
  const typeInfo = API_TYPES[uiType] || API_TYPES.proxy;
  // UI 类型映射到后端 generator（deepseek/openai → proxy）
  const generator = typeInfo.generator || uiType;

  // 获取现有配置作为基础，保留高级字段不被覆盖
  let baseConfig = {};
  try {
    const existing = await fetchApiConfig(currentApiName);
    baseConfig = existing.config || {};
  } catch {
    // 如果获取失败（可能是新建），尝试用生成器模板
    try {
      baseConfig = await fetchConfigTemplate(generator);
    } catch {
      /* 空对象兜底 */
    }
  }

  // 更新表单中的字段
  baseConfig.name = apiNameInput?.value || currentApiName;
  baseConfig[typeInfo.urlField] = apiUrlInput?.value || "";
  baseConfig.apikey = apiKeyInput?.value || "";
  baseConfig.model = apiModelInput?.value || "";

  // 切换了 generator 类型时，清理另一种类型的 URL 字段
  if (generator === "proxy") delete baseConfig.base_url;
  else if (generator === "gemini") delete baseConfig.url;

  try {
    await saveApiSource(currentApiName, { generator, config: baseConfig });
    // 保存后自动同步角色卡绑定
    await syncCharAIsource(currentApiName);
    showApiStatus("✅ 已保存", "success");
  } catch (err) {
    showApiStatus("❌ " + err.message, "error");
  }
}

// ============================================================
// 同步角色卡 AIsource 绑定
// 将当前选中的 API 源绑定到聊天中的所有角色
// ============================================================

async function syncCharAIsource(sourceName) {
  if (!sourceName || !charList || charList.length === 0) return;
  for (const charName of charList) {
    try {
      const res = await fetch(
        `/api/parts/shells:beilu-home/char-aisource/${encodeURIComponent(charName)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ AIsource: sourceName }),
        },
      );
      if (res.ok) {
        console.log(
          `[apiConfig] 角色 ${charName} AIsource 已同步为 ${sourceName}`,
        );
      } else {
        console.warn(
          `[apiConfig] 同步角色 ${charName} AIsource 失败: ${res.status}`,
        );
      }
    } catch (err) {
      console.warn(
        `[apiConfig] 同步角色 ${charName} AIsource 异常:`,
        err.message,
      );
    }
  }
}

// ============================================================
// 删除
// ============================================================

async function handleDelete() {
  if (!currentApiName) return;
  if (!confirm(`确定删除 API 配置「${currentApiName}」吗？`)) return;
  try {
    await deleteApiSource(currentApiName);
    showApiStatus("已删除", "success");
    currentApiName = null;
    await loadApiConfig();
  } catch (err) {
    showApiStatus("删除失败: " + err.message, "error");
  }
}

// ============================================================
// 新建
// ============================================================

async function handleNew() {
  const name = prompt("输入新 API 配置名称：");
  if (!name?.trim()) return;
  const safeName = name.trim();

  if (apiSources.includes(safeName)) {
    showApiStatus("该名称已存在", "error");
    return;
  }

  // 根据当前选择的 API 类型决定默认配置
  const uiType = apiTypeSelect?.value || "proxy";
  const typeInfo = API_TYPES[uiType] || API_TYPES.proxy;
  const generator = typeInfo.generator || uiType;

  let defaultConfig = {};
  try {
    defaultConfig = await fetchConfigTemplate(generator);
  } catch {
    /* 空对象兜底 */
  }

  // 不在这里预填 URL 和模型——新建后 loadApiConfig → loadApiSource 会加载配置，
  // 用户在表单中填写后通过 handleSave 保存

  try {
    await saveApiSource(safeName, { generator, config: defaultConfig });
    currentApiName = safeName;
    await loadApiConfig();
    showApiStatus("✅ 已创建", "success");
  } catch (err) {
    showApiStatus("创建失败: " + err.message, "error");
  }
}

// ============================================================
// 状态提示
// ============================================================

function showApiStatus(msg, type = "info") {
  if (!apiStatus) return;
  apiStatus.textContent = msg;
  const colorClass =
    type === "success"
      ? "text-success"
      : type === "error"
        ? "text-error"
        : "text-warning";
  apiStatus.className = `text-xs text-center mt-1 ${colorClass}`;
  apiStatus.classList.remove("hidden");
  if (type === "success") {
    setTimeout(() => apiStatus?.classList.add("hidden"), 2000);
  }
}

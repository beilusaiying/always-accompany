/**
 * beilu-home 系统设置模块
 * "系统和功能设置"选项卡 → AI 服务源管理
 *
 * 复用 serviceSourceManage 后端 API（与 beilu-chat apiConfig.mjs 相同的 API）
 */

import { t } from "../i18n.mjs";

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

async function syncAIsourceForUnboundChars(sourceName) {
  const res = await fetch("/api/parts/shells:beilu-home/sync-aisource", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sourceName }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `同步角色卡 AIsource 失败: ${res.statusText}`);
  }
  return res.json();
}

// ============================================================
// API 类型定义
// ============================================================

const API_TYPES = {
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
 */
function inferApiType(generator, config) {
  if (generator === "gemini") return "gemini";
  if (generator !== "proxy")
    return generator in API_TYPES ? generator : "proxy";
  const url = (config?.url || "").toLowerCase();
  const model = (config?.model || "").toLowerCase();
  if (url.includes("deepseek") || model.includes("deepseek")) return "deepseek";
  return "proxy";
}

// ============================================================
// 状态
// ============================================================

let currentApiName = null;
let apiSources = [];

// DOM 引用（init 时获取）
let dom = {};

// ============================================================
// 工具函数
// ============================================================

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function showStatus(msg, type = "info") {
  if (!dom.status) return;
  dom.status.textContent = msg;
  const colorClass =
    type === "success"
      ? "text-success"
      : type === "error"
        ? "text-error"
        : "text-warning";
  dom.status.className = `text-xs text-center mt-1 ${colorClass}`;
  dom.status.classList.remove("hidden");
  if (type === "success") {
    setTimeout(() => dom.status?.classList.add("hidden"), 2000);
  }
}

// ============================================================
// API 配置 — 加载列表
// ============================================================

async function loadApiList() {
  if (!dom.apiSelect) return;
  try {
    const list = await fetchApiList();
    apiSources = list;
    renderApiSelect(list);
    if (list.length > 0) {
      await loadApiSource(
        currentApiName && list.includes(currentApiName)
          ? currentApiName
          : list[0],
      );
    } else {
      clearForm();
    }
  } catch (err) {
    console.error("[beilu-home/system] 加载 API 列表失败:", err);
    showStatus("加载失败: " + err.message, "error");
  }
}

// ============================================================
// API 配置 — 渲染
// ============================================================

function renderApiSelect(list) {
  if (!dom.apiSelect) return;
  dom.apiSelect.innerHTML = "";
  if (list.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = t("sys.api.noConfig");
    dom.apiSelect.appendChild(opt);
    return;
  }
  list.forEach((name) => {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    if (name === currentApiName) opt.selected = true;
    dom.apiSelect.appendChild(opt);
  });
}

function clearForm() {
  currentApiName = null;
  if (dom.apiName) dom.apiName.value = "";
  if (dom.apiType) dom.apiType.value = "proxy";
  if (dom.apiUrl) dom.apiUrl.value = "";
  if (dom.apiKey) dom.apiKey.value = "";
  if (dom.apiModel) dom.apiModel.value = "";
  if (dom.apiDeleteBtn) dom.apiDeleteBtn.disabled = true;
  syncUrlLabel();
}

function syncUrlLabel(oldType) {
  const type = dom.apiType?.value || "proxy";
  const typeInfo = API_TYPES[type] || API_TYPES.proxy;
  if (dom.apiUrlLabel) dom.apiUrlLabel.textContent = typeInfo.urlLabel;
  if (dom.apiUrl) {
    // 如果 URL 为空或等于旧类型的默认 URL，自动填入新类型的默认 URL
    const oldTypeInfo = oldType ? API_TYPES[oldType] || API_TYPES.proxy : null;
    const currentUrl = dom.apiUrl.value.trim();
    if (
      !currentUrl ||
      (oldTypeInfo && currentUrl === oldTypeInfo.urlPlaceholder)
    ) {
      dom.apiUrl.value = typeInfo.urlPlaceholder;
    }
    dom.apiUrl.placeholder = typeInfo.urlPlaceholder;
  }
  // 如果模型为空且该类型有默认模型，自动填入
  if (dom.apiModel && !dom.apiModel.value.trim() && typeInfo.defaultModel) {
    dom.apiModel.value = typeInfo.defaultModel;
  }
}

// ============================================================
// API 配置 — 加载单个
// ============================================================

async function loadApiSource(name) {
  if (!name) return;
  currentApiName = name;
  if (dom.apiSelect) dom.apiSelect.value = name;
  try {
    const data = await fetchApiConfig(name);
    const generator = data.generator || "proxy";
    const config = data.config || {};

    if (dom.apiName) dom.apiName.value = config.name || name;
    // 用 inferApiType 推断 UI 显示类型（例如 proxy+deepseek URL → deepseek）
    const uiType = inferApiType(generator, config);
    if (dom.apiType) dom.apiType.value = uiType;

    const typeInfo = API_TYPES[uiType] || API_TYPES.proxy;
    if (dom.apiUrl) dom.apiUrl.value = config[typeInfo.urlField] || "";
    if (dom.apiKey) dom.apiKey.value = config.apikey || "";
    if (dom.apiModel) dom.apiModel.value = config.model || "";

    // 重置模型选择器
    if (dom.apiModelSelect) {
      dom.apiModelSelect.classList.add("hidden");
      dom.apiModelSelect.innerHTML = `<option value="" disabled selected>${t("sys.api.model.select")}</option>`;
    }

    syncUrlLabel();
    if (dom.apiDeleteBtn) dom.apiDeleteBtn.disabled = false;
  } catch (err) {
    console.error("[beilu-home/system] 加载 API 配置失败:", err);
    showStatus("加载失败: " + err.message, "error");
  }
}

// ============================================================
// API 配置 — 保存
// ============================================================

async function handleSave() {
  if (!currentApiName) {
    showStatus("请先选择或新建一个配置", "error");
    return;
  }
  const uiType = dom.apiType?.value || "proxy";
  const typeInfo = API_TYPES[uiType] || API_TYPES.proxy;
  // UI 类型映射到后端 generator（deepseek → proxy）
  const generator = typeInfo.generator || uiType;

  // 获取现有配置，保留高级字段
  let baseConfig = {};
  try {
    const existing = await fetchApiConfig(currentApiName);
    baseConfig = existing.config || {};
  } catch {
    try {
      baseConfig = await fetchConfigTemplate(generator);
    } catch {
      /* 空对象兜底 */
    }
  }

  baseConfig.name = (dom.apiName?.value || currentApiName).trim();
  baseConfig[typeInfo.urlField] = (dom.apiUrl?.value || "").trim();
  baseConfig.apikey = (dom.apiKey?.value || "").trim();
  baseConfig.model = (dom.apiModel?.value || "").trim();

  // 清理另一种类型的 URL 字段
  if (generator === "proxy") delete baseConfig.base_url;
  else if (generator === "gemini") delete baseConfig.url;

  try {
    await saveApiSource(currentApiName, { generator, config: baseConfig });

    try {
      const syncResult = await syncAIsourceForUnboundChars(currentApiName);
      if (syncResult?.updated > 0) {
        console.log(
          `[beilu-home/system] 已为 ${syncResult.updated} 个未配置角色同步 AIsource: ${currentApiName}`,
        );
      }
    } catch (syncErr) {
      console.warn(
        "[beilu-home/system] 同步角色卡 AIsource 失败:",
        syncErr.message,
      );
    }

    showStatus("✅ 已保存", "success");
    // 广播资源变更事件，通知其他面板（如记忆预设）刷新服务源列表
    window.dispatchEvent(
      new CustomEvent("resource:api-changed", {
        detail: { action: "save", name: currentApiName },
      }),
    );
  } catch (err) {
    showStatus("❌ " + err.message, "error");
  }
}

// ============================================================
// API 配置 — 删除
// ============================================================

async function handleDelete() {
  if (!currentApiName) return;
  if (!confirm(t("sys.api.confirmDelete", { name: currentApiName }))) return;
  try {
    const deletedName = currentApiName;
    await deleteApiSource(currentApiName);
    showStatus("已删除", "success");
    currentApiName = null;
    await loadApiList();
    // 广播资源变更事件
    window.dispatchEvent(
      new CustomEvent("resource:api-changed", {
        detail: { action: "delete", name: deletedName },
      }),
    );
  } catch (err) {
    showStatus("删除失败: " + err.message, "error");
  }
}

// ============================================================
// API 配置 — 新建
// ============================================================

async function handleNew() {
  const name = prompt(t("sys.api.promptNew"));
  if (!name?.trim()) return;
  const safeName = name.trim();

  if (apiSources.includes(safeName)) {
    showStatus("该名称已存在", "error");
    return;
  }

  // 根据当前选择的 API 类型决定默认配置
  const uiType = dom.apiType?.value || "proxy";
  const typeInfo = API_TYPES[uiType] || API_TYPES.proxy;
  const generator = typeInfo.generator || uiType;

  let defaultConfig = {};
  try {
    defaultConfig = await fetchConfigTemplate(generator);
  } catch {
    /* 空对象兜底 */
  }

  // 不在这里预填 URL 和模型——新建后 loadApiList → loadApiSource 会加载配置，
  // 用户在表单中填写后通过 handleSave 保存

  try {
    await saveApiSource(safeName, {
      generator,
      config: defaultConfig,
    });
    currentApiName = safeName;
    await loadApiList();
    showStatus("✅ 已创建", "success");
    // 广播资源变更事件
    window.dispatchEvent(
      new CustomEvent("resource:api-changed", {
        detail: { action: "create", name: safeName },
      }),
    );
  } catch (err) {
    showStatus("创建失败: " + err.message, "error");
  }
}

// ============================================================
// 初始化（由 index.mjs 调用）
// ============================================================

export async function init() {
  // 获取 DOM 引用
  dom = {
    apiSelect: document.getElementById("home-api-select"),
    apiName: document.getElementById("home-api-name"),
    apiType: document.getElementById("home-api-type"),
    apiUrlLabel: document.getElementById("home-api-url-label"),
    apiUrl: document.getElementById("home-api-url"),
    apiKey: document.getElementById("home-api-key"),
    apiModel: document.getElementById("home-api-model"),
    apiFetchModelsBtn: document.getElementById("home-api-fetch-models"),
    apiModelSelect: document.getElementById("home-api-model-select"),
    apiSaveBtn: document.getElementById("home-api-save-btn"),
    apiDeleteBtn: document.getElementById("home-api-delete-btn"),
    apiNewBtn: document.getElementById("home-api-new-btn"),
    status: document.getElementById("home-api-status"),
  };

  // 事件绑定
  dom.apiSelect?.addEventListener("change", () =>
    loadApiSource(dom.apiSelect.value),
  );
  // API 类型切换时，传入旧类型以便自动更新 URL
  let _lastApiType = dom.apiType?.value || "proxy";
  dom.apiType?.addEventListener("change", () => {
    const oldType = _lastApiType;
    _lastApiType = dom.apiType.value;
    syncUrlLabel(oldType);
  });
  dom.apiSaveBtn?.addEventListener("click", handleSave);
  dom.apiDeleteBtn?.addEventListener("click", handleDelete);
  dom.apiNewBtn?.addEventListener("click", handleNew);
  dom.apiFetchModelsBtn?.addEventListener("click", fetchModels);
  dom.apiModelSelect?.addEventListener("change", () => {
    if (dom.apiModel && dom.apiModelSelect.value) {
      dom.apiModel.value = dom.apiModelSelect.value;
    }
  });

  // 加载数据
  await loadApiList();
}

// ============================================================
// 模型获取逻辑 (移植自 proxy/display.mjs)
// ============================================================

const normalizeUrl = (url) => {
  let urlObj;
  let trimmed = (url || "").trim();
  if (!trimmed) return null;
  // 处理 protocol-relative URL（如 //api.deepseek.com/...）
  if (trimmed.startsWith("//")) trimmed = "https:" + trimmed;
  // 处理无协议 URL
  if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
    trimmed = "https://" + trimmed;
  }
  try {
    urlObj = new URL(trimmed);
  } catch {
    return null;
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

/**
 * 根据 URL 和错误信息生成 provider 友好的错误提示
 */
function getProviderFriendlyError(url, errorMsg) {
  const lower = (url || "").toLowerCase();
  const msg = (errorMsg || "").toLowerCase();

  // DeepSeek 特定提示
  if (lower.includes("deepseek")) {
    if (
      msg.includes("401") ||
      msg.includes("unauthorized") ||
      msg.includes("invalid api key")
    ) {
      return "DeepSeek API Key 无效或已过期，请检查 Key 是否正确";
    }
    if (
      msg.includes("402") ||
      msg.includes("insufficient") ||
      msg.includes("balance")
    ) {
      return "DeepSeek 账户余额不足，请前往 platform.deepseek.com 充值";
    }
    if (msg.includes("429") || msg.includes("rate") || msg.includes("频繁")) {
      return "DeepSeek 请求过于频繁，请稍后再试（免费额度有限制）";
    }
    if (
      msg.includes("fetch") ||
      msg.includes("network") ||
      msg.includes("cors")
    ) {
      return "无法连接 DeepSeek 服务器（可能被浏览器跨域策略拦截，模型列表获取失败不影响使用，可手动输入模型名）";
    }
    return `DeepSeek 错误: ${errorMsg}（模型列表获取失败不影响使用，可手动输入 deepseek-chat 或 deepseek-reasoner）`;
  }

  // OpenAI 特定提示
  if (lower.includes("openai.com")) {
    if (msg.includes("401") || msg.includes("unauthorized")) {
      return "OpenAI API Key 无效，请检查 Key 格式（应以 sk- 开头）";
    }
    if (msg.includes("429") || msg.includes("rate")) {
      return "OpenAI 请求频率受限，请稍后再试";
    }
    return `OpenAI 错误: ${errorMsg}`;
  }

  // 通用跨域提示
  if (
    msg.includes("fetch") ||
    msg.includes("network") ||
    msg.includes("cors") ||
    msg.includes("failed to fetch")
  ) {
    return `无法连接到 ${url || "API 服务器"}（可能是跨域限制或网络问题）。模型列表获取失败不影响对话功能，可手动输入模型名称。`;
  }

  return `获取模型失败: ${errorMsg}`;
}

async function fetchModels() {
  const url = (dom.apiUrl?.value || "").trim();
  const apikey = (dom.apiKey?.value || "").trim();
  const btn = dom.apiFetchModelsBtn;
  const select = dom.apiModelSelect;

  if (!url) {
    showStatus("请先填写 API URL", "error");
    return;
  }

  const modelsUrl = normalizeUrl(url);
  if (!modelsUrl) {
    showStatus("无效的 API URL", "error");
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.classList.add("loading");
  }
  showStatus("正在获取模型列表...", "info");

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
        // 解析 provider 错误信息用于友好提示
        let errDetail = `HTTP ${response.status}`;
        try {
          const errBody = await response.json();
          const msg =
            errBody?.error?.message || errBody?.message || errBody?.error;
          if (msg) errDetail = msg;
        } catch {
          /* 无法解析 JSON */
        }
        throw new Error(errDetail);
      }
    } catch (directError) {
      console.warn(
        "[system] Direct fetch failed, trying proxy...",
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
        console.error("[system] Proxy fetch also failed:", proxyError);
        throw new Error(directError.message);
      }
    }

    if (!Array.isArray(models)) throw new Error("返回数据格式错误");

    const modelIds = models.map((m) => m.id).sort();

    // 更新下拉框
    if (select) {
      select.innerHTML = `<option value="" disabled selected>${t("sys.api.model.select")}</option>`;
      modelIds.forEach((id) => {
        const opt = document.createElement("option");
        opt.value = id;
        opt.textContent = id;
        select.appendChild(opt);
      });
      select.classList.remove("hidden");
    }

    showStatus(`✅ 获取成功，共 ${modelIds.length} 个模型`, "success");
  } catch (err) {
    console.error("[system] 获取模型失败:", err);
    // 生成 provider 友好提示
    const friendlyMsg = getProviderFriendlyError(url, err.message);
    showStatus("❌ " + friendlyMsg, "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.classList.remove("loading");
    }
  }
}

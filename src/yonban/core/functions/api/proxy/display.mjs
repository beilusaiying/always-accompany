/* global geti18n */

let last_url = "";
let last_apikey = "";

/**
 * 检测 URL 是否指向本地反代服务
 * @param {string} url - API URL
 * @returns {boolean}
 */
const isLocalProxy = (url) => {
  if (!url) return false;
  try {
    const hostname = new URL(url).hostname;
    return (
      ["127.0.0.1", "localhost", "0.0.0.0", "::1"].includes(hostname) ||
      hostname.startsWith("192.168.") ||
      hostname.startsWith("10.")
    );
  } catch {
    return false;
  }
};

/**
 * 规范化 URL。
 * @param {string} url - URL。
 * @returns {string|null} 规范化的 URL。
 */
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
return async ({ data, containers, editors }) => {
  console.log("[proxy/display] Rendering...", {
    url: data.url,
    model: data.model,
  });
  const div = containers.generatorDisplay;
  const { url, apikey, model } = data;
  if (!url) {
    console.log("[proxy/display] No URL provided");
    return (div.innerHTML = "");
  }

  // 本地反代引导提示
  const localProxyTip = isLocalProxy(url)
    ? /* html */ `\
<div style="background: #2563eb10; border: 1px solid #2563eb40; border-radius: 8px; padding: 10px 14px; margin-bottom: 12px;">
	 <div style="color: #2563eb; font-size: 13px; line-height: 1.5;">
	   ℹ️ <b>本地反代配置</b> — 如使用支持模型名参数的本地反代工具：<br/>
	   <span style="opacity: 0.85;">• 假流式：模型名后加 <code style="background:#2563eb15; padding:2px 4px; border-radius:3px;">-假流式</code>（如 <code style="background:#2563eb15; padding:2px 4px; border-radius:3px;">gemini-2.5-pro-假流式</code>）</span><br/>
	   <span style="opacity: 0.85;">• 流式抗截断：模型名前加 <code style="background:#2563eb15; padding:2px 4px; border-radius:3px;">流式抗截断/</code></span><br/>
	   <span style="opacity: 0.85;">• 无需其他额外配置，以上功能通过模型名控制</span>
	 </div>
</div>
`
    : "";

  // 注入提示到 div 顶部（在后续渲染前先设置）
  if (localProxyTip) {
    const tipId = "beilu-local-proxy-tip";
    if (!div.querySelector("#" + tipId)) {
      const tipEl = document.createElement("div");
      tipEl.id = tipId;
      tipEl.innerHTML = localProxyTip;
      div.prepend(tipEl);
    }
  }
  const modelsUrl = normalizeUrl(url);
  if (!modelsUrl) {
    console.log("[proxy/display] Invalid URL");
    return (div.innerHTML = "");
  }

  console.log("[proxy/display] Models URL:", modelsUrl);

  // 如果 URL/Key 没变，但 model 变了，尝试更新 select 的选中状态（如果 select 存在）
  if (modelsUrl === last_url && apikey === last_apikey) {
    console.log(
      "[proxy/display] URL/Key unchanged, updating select value only",
    );
    const select = div.querySelector("#model-picker");
    if (select && model) {
      select.value = model;
    }
    return;
  }

  last_url = modelsUrl;
  last_apikey = apikey;
  div.innerHTML =
    /* html */ '<div data-i18n="serviceSource_manager.common_config_interface.loadingModels">Loading models...</div>';
  try {
    console.log("[proxy/display] Fetching models...");
    let models = [];

    // 1. 尝试直接请求 (Direct Fetch)
    try {
      const response = await fetch(modelsUrl, {
        headers: { Authorization: apikey ? "Bearer " + apikey : undefined },
        signal: AbortSignal.timeout(15000), // 冷路径超时（模型列举）
      });
      if (response.ok) {
        const result = await response.json();
        models = result.data || result;
      } else {
        throw new Error(`Direct fetch failed: ${response.status}`);
      }
    } catch (directError) {
      console.warn(
        "[proxy/display] Direct fetch failed, trying proxy...",
        directError,
      );

      // 2. 尝试通过 beilu-memory 代理请求 (Proxy Fetch)
      // 这是一个 fallback 机制，用于解决 CORS 问题
      try {
        const proxyResp = await fetch(
          "/api/parts/plugins:beilu-memory/config/setdata",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              _action: "getModels",
              apiConfig: { url: url, key: apikey }, // 使用原始 url，后端会处理
            }),
            signal: AbortSignal.timeout(15000), // 冷路径超时（代理 fallback）
          },
        );
        if (proxyResp.ok) {
          const proxyResult = await proxyResp.json();
          if (proxyResult.success && Array.isArray(proxyResult.models)) {
            // 构造符合格式的对象数组
            models = proxyResult.models.map((id) => ({ id }));
          } else {
            throw new Error(proxyResult.error || "Proxy returned invalid data");
          }
        } else {
          throw new Error(`Proxy fetch failed: ${proxyResp.status}`);
        }
      } catch (proxyError) {
        console.error("[proxy/display] Proxy fetch also failed:", proxyError);
        // 抛出原始错误或代理错误
        throw new Error(
          `Failed to fetch models (CORS/Network): ${directError.message}`,
        );
      }
    }

    if (!Array.isArray(models))
      throw new Error("Response is not an array of models.");

    const model_ids = models.map((m) => m.id).sort();
    const copied_text = geti18n(
      "serviceSource_manager.common_config_interface.copied",
    );

    const prefillChecked = data.convert_config?.prefill_enabled
      ? "checked"
      : "";
    // 未配置时按后端真实缺省显示 off（httpFetch claude_prefill_mode || "off"）——
    // 旧默认 "claude" 会让 UI 显示 to_user 被选中而实际不处理（显示/行为分叉）
    const currentClaudePrefillMode =
      data.convert_config?.claude_prefill_mode || "off";
    const currentPostProcessing =
      data.convert_config?.prompt_post_processing || "none";
    // provider 值域+文案由后端注入（main.mjs GetConfigDisplayContent 替换占位符，单源=apiAdapters
    // 的 PROVIDER_ENUM/PROVIDER_META；旧本地 providerLabels 硬编码已删=第二份文案，2026-07-11 收编）
    const providerEnum = JSON.parse('__PROVIDER_ENUM_JSON__');
    const providerMeta = JSON.parse('__PROVIDER_META_JSON__');
    const providerLabels = Object.fromEntries(
      Object.entries(providerMeta).map(([k, v]) => [k, v.label]),
    );
    const currentProvider = providerEnum.includes(data.convert_config?.provider)
      ? data.convert_config.provider
      : "";
    div.innerHTML = /* html */ `\
<h3 class="text-lg font-semibold" data-i18n="serviceSource_manager.common_config_interface.availableModels"></h3>
<div class="form-control w-full max-w-xs mb-4">
		<label class="label">
		  <span class="label-text">选择模型 (Select Model)</span>
		</label>
		<select id="model-picker" class="select select-bordered">
		  <option disabled selected value="">请选择...</option>
		  ${model_ids.map((id) => `<option value="${id}" ${id === model ? "selected" : ""}>${id}</option>`).join("")}
		</select>
</div>
<div class="divider my-2"></div>
<h4 class="text-md font-semibold mb-2">渠道协议</h4>
<div class="form-control w-full max-w-xs mb-2">
		<label class="label">
		  <span class="label-text">供应商协议声明</span>
		</label>
		<select id="provider-select" class="select select-sm select-bordered w-full">
		  <option value="" ${currentProvider === "" ? "selected" : ""}>${providerLabels[""]}</option>
		  ${providerEnum.map((v) => `<option value="${v}" ${currentProvider === v ? "selected" : ""}>${providerLabels[v] || v}</option>`).join("")}
		</select>
		<p class="text-xs opacity-50 ml-1 mt-1">声明此源的真实供应商协议，专项预处理与消息适配以此为准。留空=按 URL/模型名自动检测——中转/别名源检测不到关键词时专项处理会静默失效，建议显式声明。</p>
</div>
<div class="divider my-2"></div>
<h4 class="text-md font-semibold mb-2">预填充 & 后处理</h4>
<div class="form-control w-full max-w-xs mb-2">
		<label class="label cursor-pointer justify-start gap-3">
		  <input type="checkbox" id="prefill-toggle" class="toggle toggle-sm toggle-primary" ${prefillChecked} />
		  <span class="label-text">通用预填充</span>
		</label>
		<p class="text-xs opacity-50 ml-1 mt-1">开启：预设尾部 assistant 条目以 assistant 身份发送（预填充）。关闭：转为 system 身份。</p>
</div>
<div class="form-control w-full max-w-xs mb-2">
		<label class="label">
		  <span class="label-text">尾部预填充</span>
		</label>
		<select id="claude-prefill-mode" class="select select-sm select-bordered w-full">
		  <option value="off" ${currentClaudePrefillMode === "off" ? "selected" : ""} title="不处理尾部消息。渠道若不接受尾部 assistant（如 Claude 系强制 user 结尾）将由 API 返回错误，据此再选择处理模式">关闭（默认不处理）</option>
		  <option value="prefill" ${currentClaudePrefillMode === "prefill" ? "selected" : ""} title="尾部 assistant 原样发送=真预填充。需渠道支持 prefill；Claude 官方新模型已移除该能力，不支持的渠道会返回错误">尾部 assistant（渠道支持预填充）</option>
		  <option value="to_user" ${["to_user","claude","wrap_system"].includes(currentClaudePrefillMode) ? "selected" : ""} title="尾部 assistant 直接改为 user 发送，内容不变。适用于强制 user 结尾的渠道（Claude 系新模型）">尾部直接改 user（默认）</option>
		  <option value="user_assistant" ${currentClaudePrefillMode === "user_assistant" ? "selected" : ""} title="尾部改为 user 且内容末尾追加 assistant: 引导，在强制 user 结尾的渠道上加强预填充有效性">user 后加 assistant:（加强有效性）</option>
		</select>
		<p class="text-xs opacity-50 ml-1 mt-1">控制尾部 assistant 预填充消息的处理方式，对所有渠道生效，仅由此处选择决定，与提示词后处理相互独立。<br/>Claude 专项预处理（Extended Thinking/图片格式/缓存断点）按上方"供应商协议声明"生效。</p>
</div>
<div class="form-control w-full max-w-xs mb-2">
		<label class="label">
		  <span class="label-text">提示词后处理</span>
		</label>
		<select id="post-processing-select" class="select select-sm select-bordered w-full">
		  <option value="none" ${currentPostProcessing === "none" ? "selected" : ""}>无</option>
		  <option value="merge" ${currentPostProcessing === "merge" ? "selected" : ""}>合并相同角色连续发言</option>
		  <option value="semi" ${currentPostProcessing === "semi" ? "selected" : ""}>半严格（合并+system转user交替）</option>
		  <option value="strict" ${currentPostProcessing === "strict" ? "selected" : ""}>严格（合并+user在前+system仅一条）</option>
		</select>
		<p class="text-xs opacity-50 ml-1 mt-1">部分API要求严格角色交替，按需选择。</p>
</div>
<div class="form-control w-full max-w-xs mb-2">
		<label class="label">
		  <span class="label-text">多角色续写提醒文案</span>
		</label>
		<input type="text" id="role-reminding-text" class="input input-sm input-bordered w-full"
		  value="${(data.convert_config?.role_reminding_text || "").replace(/"/g, "&quot;")}"
		  placeholder='__ROLE_REMINDING_DEFAULT__' />
		<p class="text-xs opacity-50 ml-1 mt-1">多角色对话时注入的身份提醒，{charname} 会被替换为当前角色名。留空=用默认文案。</p>
</div>
<div class="divider my-2"></div>
<p class="text-sm opacity-70" data-i18n="serviceSource_manager.common_config_interface.copyModelIdTooltip"></p>
<div class="flex flex-wrap gap-2 mt-2">
${model_ids
  .map(
    (id) => /* html */ `\
<code class="p-1 bg-base-300 rounded cursor-pointer hover:bg-primary hover:text-primary-content" title="${geti18n("serviceSource_manager.common_config_interface.copyModelIdTooltip")}" onclick="navigator.clipboard.writeText('${id}'); this.innerText='${copied_text}'; setTimeout(()=>this.innerText='${id}', 1000)">${id}</code>
`,
  )
  .join("")}
</div>
`;
    // 绑定 change 事件
    const select = div.querySelector("#model-picker");
    if (select && editors && editors.json) {
      select.addEventListener("change", (e) => {
        const newModel = e.target.value;
        if (!newModel) return;

        try {
          let currentContent = editors.json.get();
          let currentJson =
            currentContent.json ||
            (currentContent.text ? JSON.parse(currentContent.text) : {});
          currentJson.model = newModel;
          if (editors.json.update) editors.json.update({ json: currentJson });
          else editors.json.set({ json: currentJson });
          console.log("[proxy/display] Model updated to:", newModel);
        } catch (err) {
          console.error("Failed to update model in editor:", err);
        }
      });
    }

    // 绑定供应商协议声明下拉框
    const providerSelect = div.querySelector("#provider-select");
    if (providerSelect && editors && editors.json) {
      providerSelect.addEventListener("change", (e) => {
        updateConvertConfig("provider", e.target.value);
      });
    }

    // 绑定多角色续写提醒文案输入框（空=删除字段回退单源默认）
    const roleRemindingInput = div.querySelector("#role-reminding-text");
    if (roleRemindingInput && editors && editors.json) {
      roleRemindingInput.addEventListener("change", (e) => {
        updateConvertConfig("role_reminding_text", e.target.value.trim());
      });
    }

    // 绑定提示词后处理下拉框
    const postProcessSelect = div.querySelector("#post-processing-select");
    if (postProcessSelect && editors && editors.json) {
      postProcessSelect.addEventListener("change", (e) => {
        updateConvertConfig("prompt_post_processing", e.target.value);
      });
    }

    // 辅助函数：更新 convert_config 中的字段
    const updateConvertConfig = (key, value) => {
      if (!editors?.json) return;
      try {
        let currentContent = editors.json.get();
        let currentJson =
          currentContent.json ||
          (currentContent.text ? JSON.parse(currentContent.text) : {});
        if (!currentJson.convert_config) currentJson.convert_config = {};
        currentJson.convert_config[key] = value;
        if (editors.json.update) editors.json.update({ json: currentJson });
        else editors.json.set({ json: currentJson });
        console.log(
          `[proxy/display] ${key}:`,
          typeof value === "string"
            ? value.length > 50
              ? value.slice(0, 50) + "..."
              : value
            : value,
        );
      } catch (err) {
        console.error(`Failed to update ${key} in editor:`, err);
      }
    };

    // 绑定通用预填充开关
    const prefillToggle = div.querySelector("#prefill-toggle");
    if (prefillToggle) {
      prefillToggle.addEventListener("change", (e) => {
        updateConvertConfig("prefill_enabled", e.target.checked);
      });
    }

    // 绑定尾部预填充模式选择器（全渠道通用，键名 claude_prefill_mode 为历史遗留）
    // （2026-07-07 删除旧"非 off 自动切 strict"联动：预填充尾部处理已收敛到后端
    //   patchBodyForClaude，与 pp 模式无关；联动会悄悄覆盖用户 pp 配置为 strict
    //   ——strict 把首条以外 system 全转 user，提示词效力全失）
    const claudePrefillModeSelect = div.querySelector("#claude-prefill-mode");
    if (claudePrefillModeSelect) {
      claudePrefillModeSelect.addEventListener("change", (e) => {
        updateConvertConfig("claude_prefill_mode", e.target.value);
      });
    }
  } catch (error) {
    console.error("Failed to fetch models:", error);
    div.innerHTML = /* html */ `
<div class="alert alert-error shadow-lg">
  <div>
    <svg xmlns="http://www.w3.org/2000/svg" class="stroke-current flex-shrink-0 h-6 w-6" fill="none" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
    <span>${geti18n("serviceSource_manager.common_config_interface.loadModelsFailed", { message: error.message })}</span>
  </div>
</div>
`;
  }
};

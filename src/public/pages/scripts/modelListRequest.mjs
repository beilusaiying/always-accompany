/**
 * 模型列表请求纯契约。
 *
 * 前端、共享状态与后端共同消费；放在 pages/scripts 以便浏览器从 /scripts 直接加载。
 * 本模块不得依赖 DOM、window、传输层或配置存储。
 */

export function normalizeModelsUrl(url) {
  let urlObj;
  try {
    urlObj = new URL(url);
  } catch {
    if (!String(url || "").startsWith("http")) {
      try {
        urlObj = new URL("https://" + url);
      } catch {
        try {
          urlObj = new URL("http://" + url);
        } catch {
          return null;
        }
      }
    } else return null;
  }

  if (urlObj.pathname.includes("/chat/completions")) {
    urlObj.pathname = urlObj.pathname.replace(/\/chat\/completions.*$/, "/models");
  } else {
    let pathname = urlObj.pathname;
    if (pathname.endsWith("/")) pathname = pathname.slice(0, -1);
    if (pathname.endsWith("/models")) urlObj.pathname = pathname;
    else if (pathname.endsWith("/v1")) urlObj.pathname = pathname + "/models";
    else urlObj.pathname = pathname + "/v1/models";
  }
  return urlObj.toString();
}

export function modelsRequestFor(entry, urlValue) {
  if (entry?.generator === "ollama") {
    const base = String(urlValue || entry.defaultUrl || "").replace(/\/$/, "");
    return {
      url: `${base}/api/tags`,
      normalize: (data) => (data?.models || [])
        .map((model) => typeof model === "string" ? model : model?.name)
        .filter(Boolean),
    };
  }
  return {
    url: normalizeModelsUrl(urlValue || "") || String(urlValue || "").replace(/\/$/, ""),
    normalize: (data) => (data?.data || data?.models || (Array.isArray(data) ? data : []))
      .map((model) => typeof model === "string" ? model : model?.id || model?.name)
      .filter(Boolean),
  };
}

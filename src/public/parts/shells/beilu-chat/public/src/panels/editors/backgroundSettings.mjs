/**
 * backgroundSettings.mjs
 * C3: 聊天背景设置（背景图上传 + 透明度 + 模糊）
 *
 * 提供：
 *   - initBackgroundSettings(deps) — 初始化背景设置系统
 *
 * deps 参数：{ showToast }
 */

import { apiFetch } from "../../shared/transport/api-client.mjs"; // R1: raw fetch → apiFetch（timeout+401；仅 :DELETE 迁移，blob/FormData 见 R1-SKIP）
import { storage, KEYS } from "../../shared/state/storage.mjs"; // R2: localStorage 集中

/**
 * 初始化聊天背景设置系统
 * - 从 localStorage 恢复设置参数（fitMode/opacity/blur）
 * - 从服务器加载已上传的背景图
 * - 绑定控件事件（上传/URL/缩放模式/滑块/重置）
 * @param {object} deps - { showToast }
 */
export function initBackgroundSettings(deps) {
  const { showToast } = deps;

  const bg1 = document.getElementById("bg1");
  const uploadBtn = document.getElementById("bg-upload-btn");
  const uploadInput = document.getElementById("bg-upload-input");
  const resetBtn = document.getElementById("bg-reset-btn");
  const urlInput = document.getElementById("bg-url-input");
  const fitModeSelect = document.getElementById("bg-fit-mode");
  const opacitySlider = document.getElementById("bg-opacity-slider");
  const opacityValue = document.getElementById("bg-opacity-value");
  const blurSlider = document.getElementById("bg-blur-slider");
  const blurValue = document.getElementById("bg-blur-value");

  if (!bg1) return;

  // ---- 工具函数 ----

  /** 应用背景图到 #bg1 */
  function applyBgImage(url) {
    if (!url) {
      bg1.style.backgroundImage = "";
      document.body.classList.remove("has-bg-image");
      return;
    }
    bg1.style.backgroundImage = `url("${url}")`;
    document.body.classList.add("has-bg-image");
  }

  /** 应用缩放模式 */
  function applyFitMode(mode) {
    bg1.classList.remove(
      "fit-cover",
      "fit-contain",
      "fit-stretch",
      "fit-center",
    );
    bg1.classList.add(`fit-${mode}`);
    if (fitModeSelect) fitModeSelect.value = mode;
    storage.set(KEYS.BEILU_BG_FIT, mode);
  }

  /** 应用透明度 */
  function applyOpacity(val) {
    const v = parseInt(val, 10);
    document.documentElement.style.setProperty(
      "--chat-bg-opacity",
      (v / 100).toFixed(2),
    );
    if (opacitySlider) opacitySlider.value = v;
    if (opacityValue) opacityValue.textContent = `${v}%`;
    storage.set(KEYS.BEILU_BG_OPACITY, v);
  }

  /** 应用模糊强度 */
  function applyBlur(val) {
    const v = parseInt(val, 10);
    document.documentElement.style.setProperty("--chat-bg-blur", `${v}px`);
    if (blurSlider) blurSlider.value = v;
    if (blurValue) blurValue.textContent = `${v}px`;
    storage.set(KEYS.BEILU_BG_BLUR, v);
  }

  // ---- 恢复 localStorage 参数 ----
  const savedFit = storage.get(KEYS.BEILU_BG_FIT) || "cover";
  const savedOpacity = storage.get(KEYS.BEILU_BG_OPACITY) ?? "30";
  const savedBlur = storage.get(KEYS.BEILU_BG_BLUR) ?? "10";
  const savedUrl = storage.get(KEYS.BEILU_BG_URL) || "";

  applyFitMode(savedFit);
  applyOpacity(savedOpacity);
  applyBlur(savedBlur);

  // ---- 从服务器加载已上传的背景图 ----
  // T014 收编：原 R1-SKIP（blob 不适用 json 解析）——apiFetch 有 raw:true 直返 Response（diagLogger 同型先例），
  // 收编后获得超时+401 单一权威+带 method/url 的错误 context，.then/.catch 链原样。
  apiFetch("/api/parts/shells:chat/background", { raw: true, credentials: "include" })
    .then((res) => {
      if (res.status === 204) {
        if (savedUrl) {
          applyBgImage(savedUrl);
          if (urlInput) urlInput.value = savedUrl;
        }
        return null;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.blob();
    })
    .then((blob) => {
      if (!blob) return;
      const objectUrl = URL.createObjectURL(blob);
      applyBgImage(objectUrl);
      storage.set(KEYS.BEILU_BG_SOURCE, "upload");
    })
    .catch((err) => {
      console.warn("[beilu-chat] 加载背景图失败:", err.message);
      if (savedUrl) {
        applyBgImage(savedUrl);
        if (urlInput) urlInput.value = savedUrl;
      }
    });

  // ---- 控件事件绑定 ----

  // 上传按钮 → 触发 file input
  uploadBtn?.addEventListener("click", () => uploadInput?.click());

  // 文件选中 → 上传到服务器
  uploadInput?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const formData = new FormData();
    formData.append("file", file);

    try {
      // T6b 门面登记·不收：multipart/FormData 二进制上传（非 JSON body），sendAction 门面 buildBody 走 JSON 不适用；
      //   与本文件背景图 blob 下载（R1-SKIP，见 L96/L171 fetch）同属二进制 I/O 特例，保留 apiFetch 直连。
      const res = await apiFetch("/api/parts/shells:chat/background", {
        method: "POST", raw: true,
        body: formData,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      const objectUrl = URL.createObjectURL(file);
      applyBgImage(objectUrl);
      storage.set(KEYS.BEILU_BG_SOURCE, "upload");
      storage.remove(KEYS.BEILU_BG_URL);
      if (urlInput) urlInput.value = "";
      showToast("背景图已上传", "success");
    } catch (err) {
      showToast("背景图上传失败: " + err.message, "error");
    }

    uploadInput.value = "";
  });

  // URL 输入 → 回车应用
  urlInput?.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const url = urlInput.value.trim();
    if (url) {
      applyBgImage(url);
      storage.set(KEYS.BEILU_BG_URL, url);
      storage.set(KEYS.BEILU_BG_SOURCE, "url");
      showToast("背景图已应用（URL模式）", "success");
    } else {
      storage.remove(KEYS.BEILU_BG_URL);
      storage.set(KEYS.BEILU_BG_SOURCE, "upload");
      // T014 收编：同上，apiFetch raw:true 直返 Response
      apiFetch("/api/parts/shells:chat/background", { raw: true, credentials: "include" })
        .then((res) => (res.status === 204 ? null : res.blob()))
        .then((blob) => {
          if (blob) applyBgImage(URL.createObjectURL(blob));
          else applyBgImage("");
        })
        .catch(() => applyBgImage(""));
    }
  });

  // URL 输入失焦 → 也应用
  urlInput?.addEventListener("blur", () => {
    const url = urlInput.value.trim();
    const savedSource = storage.get(KEYS.BEILU_BG_SOURCE);
    if (url && savedSource !== "upload") {
      applyBgImage(url);
      storage.set(KEYS.BEILU_BG_URL, url);
      storage.set(KEYS.BEILU_BG_SOURCE, "url");
    }
  });

  // 缩放模式选择
  fitModeSelect?.addEventListener("change", () => {
    applyFitMode(fitModeSelect.value);
  });

  // 透明度滑块
  opacitySlider?.addEventListener("input", () => {
    applyOpacity(opacitySlider.value);
  });

  // 模糊强度滑块
  blurSlider?.addEventListener("input", () => {
    applyBlur(blurSlider.value);
  });

  // 重置按钮 → 清除背景图 + 删除服务器文件
  resetBtn?.addEventListener("click", async () => {
    applyBgImage("");
    storage.remove(KEYS.BEILU_BG_URL);
    storage.remove(KEYS.BEILU_BG_SOURCE);
    if (urlInput) urlInput.value = "";

    applyFitMode("cover");
    applyOpacity("30");
    applyBlur("10");

    try {
      // T6b 门面登记·不收：属背景图二进制资源 endpoint（同 POST 上传/GET blob 下载一组），保持本 endpoint 直连一致性，不拆走 DELETE。
      await apiFetch("/api/parts/shells:chat/background", {
        method: "DELETE",
        credentials: "include",
        raw: true,
      });
    } catch (err) {
      console.warn("[beilu-chat] 删除服务器背景图失败:", err.message);
    }

    showToast("背景已重置为默认", "info");
  });

  console.log("[beilu-chat] 背景设置已初始化");
}

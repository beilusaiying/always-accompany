/** 从总入口拆出的 Companion 首次激活接线。 */
import { ensureLive2dVendorRuntime } from "./live2dRuntimeLoader.mjs";
import {
  configureCompanionRendererLoader,
  refreshCompanionRendererSettings,
  setCompanionRendererState,
} from "../../panels/companion/companion.mjs";
import { startEyeActivePoll } from "../../panels/companion/eye.mjs";

let _companionRendererState = "idle";
let _companionRendererPromise = null;

function ensureCompanionRenderer() {
  if (_companionRendererState === "ready" && _companionRendererPromise) return _companionRendererPromise;
  if (_companionRendererPromise) return _companionRendererPromise;

  _companionRendererState = "loading";
  setCompanionRendererState("loading");
  _companionRendererPromise = import("./live2dRenderer.mjs")
    .then(async ({ initLive2dRenderer }) => {
      const ok = await initLive2dRenderer({ ensureVendorRuntime: ensureLive2dVendorRuntime });
      if (!ok || !window.beiluLive2d?.ready?.()) throw new Error("虚拟形象渲染器未进入 ready 状态");
      refreshCompanionRendererSettings();
      _companionRendererState = "ready";
      setCompanionRendererState("ready");
      return window.beiluLive2d;
    })
    .catch((error) => {
      _companionRendererState = "idle";
      _companionRendererPromise = null;
      setCompanionRendererState("error", error);
      throw error;
    });
  return _companionRendererPromise;
}

export function initCompanionActivation() {
  configureCompanionRendererLoader(ensureCompanionRenderer);
  window.addEventListener("beilu:tab-activated", (event) => {
    if (event.detail !== "companion") return;
    startEyeActivePoll();
    ensureCompanionRenderer().catch((error) => {
      console.error("[live2d] Companion 渲染器初始化失败:", error);
      window._reportError?.(`[live2d] Companion 渲染器初始化失败: ${error?.message || error}`, error?.stack);
    });
  });
}

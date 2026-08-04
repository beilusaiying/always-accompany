/**
 * Live2D vendor 运行时懒加载器。
 *
 * 只在真正选中 Live2D 形象时按 core → pixi → cubism4 顺序注入本地脚本。
 * loading 期间所有调用方共用同一 Promise；任一脚本失败都删除该 script 并回到 idle，
 * 使用户可以在资源恢复后显式重试。
 */

const RUNTIME_SCRIPTS = [
  { src: "./vendor/live2dcubismcore.min.js", ready: () => !!window.Live2DCubismCore },
  { src: "./vendor/pixi.min.js", ready: () => !!window.PIXI },
  { src: "./vendor/cubism4.min.js", ready: () => !!window.PIXI?.live2d?.Live2DModel },
];

let _state = "idle";
let _runtimePromise = null;

function _loadScript(entry) {
  if (entry.ready()) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = entry.src;
    script.async = false;
    script.dataset.beiluLive2dRuntime = entry.src;

    const fail = (reason) => {
      script.remove();
      reject(reason instanceof Error ? reason : new Error(String(reason)));
    };
    script.addEventListener("load", () => {
      if (entry.ready()) resolve();
      else fail(new Error(`Live2D 运行时脚本已加载但未建立预期全局对象: ${entry.src}`));
    }, { once: true });
    script.addEventListener("error", () => fail(new Error(`Live2D 运行时脚本加载失败: ${entry.src}`)), { once: true });
    try {
      document.head.appendChild(script);
    } catch (error) {
      fail(error);
    }
  });
}

export function getLive2dVendorRuntimeState() {
  return _state;
}

export function ensureLive2dVendorRuntime() {
  if (_state === "ready") return Promise.resolve(window.PIXI.live2d);
  if (_runtimePromise) return _runtimePromise;

  _state = "loading";
  _runtimePromise = (async () => {
    for (const entry of RUNTIME_SCRIPTS) await _loadScript(entry);
    _state = "ready";
    return window.PIXI.live2d;
  })().catch((error) => {
    _state = "idle";
    _runtimePromise = null;
    throw error;
  });
  return _runtimePromise;
}

/** 页面启动遮罩与 boot-ready 的唯一收口。 */
function settleBootOverlay(error = null) {
  const overlay = document.getElementById("app-boot-overlay");
  if (!overlay) return;
  if (!error) {
    overlay.remove();
    return;
  }
  overlay.dataset.state = "failed";
  overlay.setAttribute("aria-busy", "false");
  const spinner = document.getElementById("app-boot-spinner");
  const status = document.getElementById("app-boot-status");
  const retry = document.getElementById("app-boot-retry");
  if (spinner) spinner.hidden = true;
  if (status) status.textContent = `界面初始化失败：${error?.message || error}`;
  if (retry) {
    retry.hidden = false;
    retry.addEventListener("click", () => window.location.reload(), { once: true });
  }
}

export function runBoot(init) {
  init()
    .then(() => {
      settleBootOverlay();
      document.body.dataset.beiluBootReady = "1";
      window.dispatchEvent(new CustomEvent("beilu:boot-ready"));
      import("/parts/plugins:beilu-st-host/host-loader.mjs")
        .then((module) => module.initStHost?.())
        .catch((error) => console.warn("[beilu-st-host] 宿主 loader 未加载：", error));
    })
    .catch((error) => {
      console.error("[beilu-chat] 顶层初始化中断:", error);
      window._reportError?.(`[beilu-chat] 顶层初始化中断: ${error?.message || error}`, error?.stack);
      settleBootOverlay(error);
    });
}

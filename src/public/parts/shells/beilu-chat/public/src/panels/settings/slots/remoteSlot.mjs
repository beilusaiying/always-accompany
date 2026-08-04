// remoteSlot.mjs — 设置面板·远程访问 slot（自 settingsSlots.mjs 拆出，2026-08-03，内容逐字搬迁）
import { copyWithFeedback } from "../../../shared/state/utils.mjs";
import { apiFetch } from "../../../shared/transport/api-client.mjs";

// ============================================================
// 远程访问 slot
// ============================================================

export async function initRemoteSlot() {
  const slot = document.getElementById("settings-remote-slot");
  if (!slot) return;

  slot.innerHTML = '<div class="text-sm text-base-content/50 mt-2">获取网络信息...</div>';

  try {
    const resp = await apiFetch("/api/parts/shells:chat/network-info", { raw: true });
    const data = await resp.json();
    const port = data.port || location.port || 1314;
    const ips = data.ips || [];

    const addresses = ips.map(ip => `http://${ip.address}:${port}`);

    slot.innerHTML = `
      <div class="space-y-4 mt-2">
        <div class="p-3 bg-base-200 rounded-lg">
          <h4 class="text-sm font-medium mb-2">局域网访问地址</h4>
          <div class="space-y-2">
            ${addresses.length > 0 ? addresses.map(addr => `
              <div class="flex items-center justify-between gap-2 p-2 bg-base-100 rounded">
                <code class="text-xs font-mono flex-1 truncate">${addr}</code>
                <button class="btn btn-xs btn-ghost remote-copy-btn" data-url="${addr}" title="复制">📋</button>
              </div>
            `).join("") : '<p class="text-xs text-base-content/40">未检测到局域网地址</p>'}
          </div>
          <p class="text-xs text-base-content/40 mt-2">在同一局域网的设备上打开以上地址即可访问</p>
        </div>

        <div class="p-3 bg-base-200 rounded-lg">
          <h4 class="text-sm font-medium mb-2">手机扫码连接</h4>
          <p class="text-xs text-base-content/40">使用手机浏览器扫描二维码，即可在手机上使用 always accompany</p>
          <div id="settings-qrcode" class="flex justify-center mt-2">
            ${addresses.length > 0
              ? `<img src="https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(addresses[0])}"
                   alt="QR Code" class="rounded-lg" width="160" height="160" />`
              : '<p class="text-xs text-base-content/40">无可用地址</p>'}
          </div>
        </div>
      </div>
    `;

    // 复制按钮
    slot.querySelectorAll(".remote-copy-btn").forEach(btn => {
      btn.addEventListener("click", () => copyWithFeedback(btn.dataset.url, btn, "✅"));
    });
  } catch {
    slot.innerHTML = '<div class="text-sm text-error mt-2">获取网络信息失败</div>';
  }
}

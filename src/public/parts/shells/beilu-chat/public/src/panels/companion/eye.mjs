/**
 * @file eye.mjs — 图片压缩工具 + 桌面截图（桌面截图陪伴轮询）cluster
 *
 * 【功能链】
 *   compressImageBase64（Canvas API 多级压缩：JPEG q=0.7 → q=0.4 → 分辨率减半+q=0.2，
 *       直至低于 IMAGE_MAX_BYTES=5MB；<1MB JPEG 直接跳过）
 *   → startEyePoll / pollEyeStatus（setInterval 轮询 /api/eye，检测 hasPending）
 *   → consumeEye（POST 消费截图数据 → compressImageBase64 压缩 → addUserReply 发送给 AI）
 *
 * 【why】
 *   ★ 此模块与 Live2D 渲染无关，是纯截图感知通道：
 *   后端 beilu-eye 插件在桌面截图就绪时置 hasPending，前端轮询消费后通过
 *   addUserReply 将截图注入对话，让 AI 能"看到"用户当前屏幕。
 *   Claude API 单图上限 5MB，多级压缩确保截图必然可发送。
 *
 * 【关联链】
 *   上游：index.mjs（调用 startEyeActivePoll；initEyeStatusUI 死段已删T006）
 *   依赖：panels/airp/utils.mjs（showToast）
 *   核心依赖：shared/transport/endpoints.mjs（addUserReply）、shared/transport/api-client.mjs（apiFetch）
 *   后端接口：/api/eye（GET 检测）、/api/eye/consume（POST 消费）
 *
 * 【影响范围】
 *   仅在 beilu-eye 插件启用且桌面截图就绪时触发；
 *   addUserReply 发送后会触发 AI 回复流程，影响对话节奏（有20s冷却）。
 *
 * 【使用效果】
 *   import { startEyeActivePoll } from "./eye.mjs"
 *   启动后每隔固定间隔检查截图队列；截图自动压缩至5MB以内发送，
 *   AI 可以"感知"用户正在做什么。
 */
import { showToast } from "../airp/utils.mjs";
import { addUserReply } from "../../shared/transport/endpoints.mjs";
import { sendAction } from "../../shared/transport/sendAction.mjs"; // T6b批7：出向统一门面（verb=真动作），/api/eye/* 自定义服务端路由收口（server:eye target）

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
// 桌面截图 — 桌面截图主动发送轮询 + 状态 UI
// ============================================================

/** 轮询定时器 */
let _eyePollTimer = null;
/** 防止重复发送的冷却时间戳 */
let _eyeCooldownUntil = 0;

// P0 修复（beilu-eye 404）：绕过 beilu parts API，使用自定义路由
// beilu 框架未为 beilu-eye 注册 HTTP 路由，导致 /api/parts/plugins:beilu-eye/... 返回 404
// 改用 endpoints.mjs 中注册的 /api/eye/* 自定义路由（T6b批7 收口为 sendAction server:eye target；URL 常量迁入门面路由）

// T006死码批: initEyeStatusUI（旧右栏残段，原:203-250）已删——eye-restart/stop/clear-btn 三 DOM
// 在 index.html 零存在（按钮从未绑上），入口唯一调用点 index.mjs:541 同批删。
// T5#9 纯删(2026-07-13): updateEyeStatusUI/fetchEyeStatusForUI 同批删——其操作的四个 DOM
// (eye-status-dot/eye-status-text/eye-snapshot-count/eye-error-row)全仓零存在(只剩函数自身引用),
// 每次调用 !dot||!text 早退=死显示面;_eyeSentCount 唯一消费也是它,随删。主动发送活链路(下方)不动。

/**
 * 启动桌面截图主动发送轮询
 * 每2秒检查 /api/eye/status，如果有 mode=active 的待注入截图，
 * 自动调用 addUserReply 发送消息触发 AI 回复
 */
function startEyeActivePoll() {
  if (_eyePollTimer) return;
  _eyePollTimer = setInterval(pollEyeStatus, 2000);
  console.log("[beilu-chat] 桌面截图主动发送轮询已启动");
}

async function pollEyeStatus() {
  // 冷却期内跳过
  if (Date.now() < _eyeCooldownUntil) return;
  try {
    // T6b批7：/api/eye/status → sendAction server:eye#getStatus。!ok 由门面抛错走外层 catch（原 !resp.ok return，等价）。
    const data = await sendAction({ verb: "getStatus", target: "server:eye", source: "web" });
    if (data.hasPending && data.mode === "active") {
      _eyeCooldownUntil = Date.now() + 20000;
      console.log(
        "[beilu-chat] 检测到桌面截图（主动发送模式），获取截图数据...",
      );
      try {
        // T6b批7：/api/eye/consume POST → sendAction server:eye#consume。!ok 由门面抛错走内层 catch（原 !consumeResp.ok 分支等价：置 3s 冷却）。
        const eyeData = await sendAction({ verb: "consume", target: "server:eye", source: "web" });
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

export { startEyeActivePoll };

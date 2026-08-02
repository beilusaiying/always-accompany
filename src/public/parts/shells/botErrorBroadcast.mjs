/**
 * botErrorBroadcast.mjs — 10 平台 Bot 共享错误广播层（BR2）
 *
 * 职责：把任一 Bot 壳的启动/连接/运行时错误，经 beilu-chat 已有的广播通道
 *       （broadcast.mjs / broadcastAllChatUi）以结构化 `bot_error` 事件只推给
 *       该 Bot 所属用户的聊天 UI，前端 botSidePanels [O] 监控红点据此计数。
 *
 * 设计依据：
 *   - 复用既有通道：与 replyHandler `_broadcastCloneStatus` 同型（动态 import
 *     broadcast.mjs，避免在 bot 壳内静态依赖 chat 壳造成加载耦合）。
 *   - 选 broadcastAllChatUi(event, username)（非 broadcastChatEvent）：Bot 进程无 chatId，
 *     但始终有用户 owner；该用户打开的所有 UI 都应看到红点，绝不能跨用户全投。
 *   - 不新造端点/不改 broadcast.mjs：producer 一律走现有导出函数。
 *
 * 事件协议（与 websocket.mjs handleBroadcastEvent 对齐）：
 *   { type: "bot_error", payload: { platform, botname, phase, message, timestamp } }
 *     phase: "start" | "runtime" | "connect"（产生错误的环节，便于前端分类）
 */

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// shells/botErrorBroadcast.mjs → shells/beilu-chat/src/lib/broadcast.mjs
const _broadcastPath = path.join(
  __dirname,
  "beilu-chat",
  "src",
  "lib",
  "broadcast.mjs",
);

// shells/botErrorBroadcast.mjs → src/server/web_server/event_dispatcher.mjs（通道B 用户级桌面通知）
const _eventDispatcherPath = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "server",
  "web_server",
  "event_dispatcher.mjs",
);

/**
 * 广播一条结构化 Bot 错误事件到 Bot owner 的已连接聊天 UI。
 * 任何失败都静默吞掉——错误外显是「锦上添花」，绝不能因广播失败反过来影响 Bot 主流程。
 *
 * @param {object} info
 * @param {string} info.username - Bot 所属用户；缺失时 fail-closed，不发送
 * @param {string} info.platform - 平台 shell 名（discordbot / telegrambot / ...）
 * @param {string} info.botname  - Bot 名称
 * @param {string} [info.phase="runtime"] - 错误环节 start|runtime|connect
 * @param {string|Error} info.error - 错误对象或消息
 */
export function broadcastBotError({ username, platform, botname, phase = "runtime", error }) {
  if (typeof username !== "string" || !username) return false;
  try {
    const message =
      error instanceof Error ? error.message : String(error ?? "未知错误");
    import(pathToFileURL(_broadcastPath).href)
      .then((_bc) => {
        if (typeof _bc.broadcastAllChatUi !== "function") return;
        _bc.broadcastAllChatUi({
          type: "bot_error",
          payload: {
            platform: platform || "",
            botname: botname || "",
            phase,
            message,
            timestamp: new Date().toISOString(),
          },
        }, username);
      })
      .catch(() => {
        /* broadcast 层不可用（如 chat 壳未加载）→ 静默 */
      });

    // 桌面 OS 通知（通道B sendEventToUser → owner 各页 base.mjs onServerEvent('notification') → notifyDesktop）。
    // 仅 start/connect 失败推：这是「Bot 起不来」的稀有重要事件，失焦/最小化也该看到；
    // runtime 错误频繁，只走上面红点不弹通知，避免打扰。tag 按平台去重，重试不堆叠。
    // [dead-branch:connect] 截至 2026-06-24 审计：phase="connect" 0 producer。
    //   9 壳（0716 删 kookbot 后）均只广播 "start"（启动失败）和 "runtime"（运行时错误）。
    //   长连接壳（discord/telegram）的重连失败走 ws.on('error')→"runtime"，
    //   无独立 connect 阶段错误分离。保留此分支供未来长连接壳拆分 connect 语义时使用。
    if (phase === "start" || phase === "connect") {
      import(pathToFileURL(_eventDispatcherPath).href)
        .then((_ed) => {
          if (typeof _ed.sendEventToUser !== "function") return;
          _ed.sendEventToUser(username, "notification", {
            title: `Bot ${phase === "start" ? "启动" : "连接"}失败：${platform || ""}`,
            options: {
              body: `${botname || ""} — ${message}`.slice(0, 120),
              tag: `bot-error-${platform || "?"}`,
            },
          });
        })
        .catch(() => { /* 事件分发层不可用 → 静默 */ });
    }
    return true;
  } catch {
    /* 同步阶段任何异常都不外抛 */
    return false;
  }
}

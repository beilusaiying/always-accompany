import { createDiag } from "../../../../server/diagLogger.mjs";
import { setDefaultPart } from "../../../../server/parts_loader.mjs";
import info from "./info.json" with { type: "json" };
import {
  consumePendingBrowserInjection,
  getPendingBrowserStatus,
  setPendingBrowserInjection,
} from "./injection_state.mjs";

const diag = createDiag("browser");

// ============================================================
// beilu-browser 插件 — 浏览器页面感知
//
// 职责：
// - 接收来自 Tampermonkey 油猴脚本的浏览器页面快照
// - 缓存最近的页面快照（环形缓冲区）
// - GetPrompt: 将最新页面内容作为上下文注入给 AI
// - AI 可以"感知"主人当前正在浏览的网页内容
// ============================================================

/** 页面快照环形缓冲区 */
const MAX_SNAPSHOTS = 5;
const pageSnapshots = [];

/** 配置 */
/** 配置 */
let browserConfig = {
  enabled: true,
  maxContentLength: 20000, // 注入给 AI 的最大文本长度（主人要求至少 20000 token 级别）
  autoInject: true, // 是否自动注入最新页面到 GetPrompt
  injectMode: "latest", // 'latest' = 只注入最新一个 | 'all' = 注入所有缓存
};

/**
 * 一次性 pending 注入缓存
 * 前端 consumeBrowser 后存入此处，GetPrompt 读取后自动清除
 * 实现"不显示在聊天界面、临时单次注入 AI 上下文"的效果
 * @type {{ content: string, title: string, url: string, selectedText: string, message: string } | null}
 */
let _pendingPromptInjection = null;

/**
 * 设置一次性 prompt 注入数据（GetPrompt 消费后自动清除）
 * @param {object} data - { content, title, url, selectedText, message }
 */
function setPendingPromptInjection(data) {
  _pendingPromptInjection = {
    content: data.content || "",
    title: data.title || "",
    url: data.url || "",
    selectedText: data.selectedText || "",
    message: data.message || "",
    timestamp: Date.now(),
  };
  diag.log(
    "setPendingPromptInjection: 已缓存一次性注入数据",
    `| title: ${data.title || "(无)"}`,
    `| content: ${(data.content || "").length}字符`,
    `| selectedText: ${(data.selectedText || "").length}字符`,
  );
}

/**
 * 消费一次性 prompt 注入数据（读取后清除）
 * @returns {object|null}
 */
function consumePendingPromptInjection() {
  const data = _pendingPromptInjection;
  _pendingPromptInjection = null;
  return data;
}
/**
 * 添加页面快照到环形缓冲区
 * @param {object} snapshot - { url, title, content, selectedText?, timestamp? }
 */
function pushSnapshot(snapshot) {
  // 数据完整性检查
  if (!diag.guard(snapshot, ["url"], "pushSnapshot")) {
    diag.warn("pushSnapshot: 快照数据不完整", {
      keys: Object.keys(snapshot || {}),
    });
  }

  const entry = {
    url: snapshot.url || "",
    title: snapshot.title || "",
    content: (snapshot.content || "").substring(0, 50000), // 原始内容最大 50KB
    selectedText: snapshot.selectedText || "",
    timestamp: snapshot.timestamp || Date.now(),
    receivedAt: Date.now(),
  };

  pageSnapshots.push(entry);

  // 环形缓冲区：超过最大数量时移除最旧的
  while (pageSnapshots.length > MAX_SNAPSHOTS) {
    pageSnapshots.shift();
  }

  diag.log(
    "收到页面快照:",
    entry.title,
    `(${entry.url.substring(0, 60)})`,
    `| 内容长度: ${entry.content.length}`,
    `| 选中文本: ${entry.selectedText ? entry.selectedText.length + "字符" : "无"}`,
    `| 缓冲区: ${pageSnapshots.length}/${MAX_SNAPSHOTS}`,
  );
}

/**
 * 获取最新的页面快照
 * @returns {object|null}
 */
function getLatestSnapshot() {
  return pageSnapshots.length > 0
    ? pageSnapshots[pageSnapshots.length - 1]
    : null;
}

/**
 * 格式化页面快照为 AI 可读文本
 * @param {object} snapshot - 页面快照
 * @param {number} maxLen - 最大文本长度
 * @returns {string}
 */
function formatSnapshotForAI(snapshot, maxLen = 3000) {
  if (!snapshot) return "";

  const parts = [];
  parts.push(`[当前浏览页面]`);
  parts.push(`标题: ${snapshot.title}`);
  parts.push(`URL: ${snapshot.url}`);

  if (snapshot.selectedText) {
    parts.push(`\n用户选中的文本:`);
    parts.push(snapshot.selectedText.substring(0, Math.floor(maxLen / 2)));
  }

  const remainingLen = maxLen - parts.join("\n").length - 50;
  if (remainingLen > 100 && snapshot.content) {
    parts.push(`\n页面内容摘要:`);
    parts.push(snapshot.content.substring(0, remainingLen));
    if (snapshot.content.length > remainingLen) {
      parts.push(
        `...(页面内容已截断，原始长度: ${snapshot.content.length} 字符)`,
      );
    }
  }

  const timeDiff = Date.now() - snapshot.receivedAt;
  const timeStr =
    timeDiff < 60000
      ? `${Math.floor(timeDiff / 1000)}秒前`
      : timeDiff < 3600000
        ? `${Math.floor(timeDiff / 60000)}分钟前`
        : `${Math.floor(timeDiff / 3600000)}小时前`;
  parts.push(`\n(${timeStr}接收)`);
  parts.push(`[/当前浏览页面]`);

  return parts.join("\n");
}

// ============================================================
// 插件导出
// ============================================================

const pluginExport = {
  info,
  Load: async ({ router, username }) => {
    // 自动注册为默认插件，确保 GetPrompt 会被 chat.mjs 调用
    if (username) {
      setDefaultPart(username, "plugins", "beilu-browser");
      diag.log("已自动注册为默认插件 (plugins/beilu-browser)");
    }
    diag.log("Load() — 浏览器页面感知插件已加载");
    diag.debug("配置:", {
      enabled: browserConfig.enabled,
      autoInject: browserConfig.autoInject,
      maxContentLength: browserConfig.maxContentLength,
      injectMode: browserConfig.injectMode,
    });

    // 注册 HTTP 路由（供油猴脚本调用）
    if (router) {
      router.get(
        "/api/parts/plugins\\:beilu-browser/config/getdata",
        async (req, res) => {
          try {
            const data = await pluginExport.interfaces.config.GetData();
            res.json(data);
          } catch (err) {
            res.status(500).json({ error: err.message });
          }
        },
      );

      router.post(
        "/api/parts/plugins\\:beilu-browser/config/setdata",
        async (req, res) => {
          try {
            const result = await pluginExport.interfaces.config.SetData(
              req.body,
            );
            res.json(result || { success: true });
          } catch (err) {
            res.status(500).json({ error: err.message });
          }
        },
      );

      diag.log("HTTP 路由已注册: /config/getdata, /config/setdata");
    }
  },

  Unload: async () => {
    diag.log(
      "Unload() — 浏览器页面感知插件已卸载",
      `| 快照数: ${pageSnapshots.length}`,
    );
  },

  interfaces: {
    config: {
      /**
       * 获取插件状态和数据
       */
      GetData: async () => {
        const pendingStatus = getPendingBrowserStatus();
        return {
          enabled: browserConfig.enabled,
          autoInject: browserConfig.autoInject,
          maxContentLength: browserConfig.maxContentLength,
          snapshotCount: pageSnapshots.length,
          // pending 注入状态（前端轮询用）
          hasPending: pendingStatus.hasPending,
          pendingMessage: pendingStatus.message,
          pendingTitle: pendingStatus.title,
          pendingUrl: pendingStatus.url,
          latestSnapshot: getLatestSnapshot()
            ? {
                url: getLatestSnapshot().url,
                title: getLatestSnapshot().title,
                contentLength: getLatestSnapshot().content.length,
                receivedAt: getLatestSnapshot().receivedAt,
              }
            : null,
          description:
            "贝露的浏览器感知 — 接收油猴脚本推送的页面内容，注入 AI 上下文",
        };
      },

      /**
       * 设置数据 / 接收页面快照 / 控制操作
       */
      SetData: async (data) => {
        if (!data) return;

        // 接收页面快照（含可选的消息附带，用于主动发送模式）
        if (data._action === "pushPage") {
          if (!data.url && !data.content) {
            diag.warn("pushPage: 缺少 url 和 content，数据被丢弃", {
              receivedKeys: Object.keys(data),
            });
            return;
          }
          pushSnapshot(data);

          // 如果附带了 message，存入 pending 注入状态（主动发送模式）
          // 前端轮询检测到后会自动发送用户消息触发 AI 回复
          if (data.message) {
            setPendingBrowserInjection({
              url: data.url || "",
              title: data.title || "",
              content: (data.content || "").substring(0, 50000),
              selectedText: data.selectedText || "",
              message: data.message,
            });
            diag.log(
              "pushPage: 已设置 pending 注入（主动发送模式）",
              `| message: ${data.message.substring(0, 50)}`,
            );
          }

          return { success: true, snapshotCount: pageSnapshots.length };
        }

        // 获取浏览器 pending 状态（前端轮询用）
        if (data._action === "getBrowserStatus") {
          return getPendingBrowserStatus();
        }

        // 消费 pending 注入数据 — 改造后：消费并同时存入一次性 GetPrompt 注入缓存
        // 前端不再用 addUserReply 显示在聊天界面，而是调用此接口后 triggerCharacterReply
        // GetPrompt 检测到 _pendingPromptInjection 时注入并自动清除
        if (data._action === "consumeBrowser") {
          const consumed = consumePendingBrowserInjection();
          if (consumed) {
            // 将消费到的数据存入一次性 GetPrompt 注入缓存
            setPendingPromptInjection({
              content: consumed.content || "",
              title: consumed.title || "",
              url: consumed.url || "",
              selectedText: consumed.selectedText || "",
              message: consumed.message || "",
            });

            diag.log(
              "consumeBrowser: pending 数据已消费 → 已存入一次性 GetPrompt 注入缓存",
              `| title: ${consumed.title}`,
              `| message: ${consumed.message.substring(0, 50)}`,
              `| content: ${consumed.content?.length || 0}字符`,
              `| selectedText: ${consumed.selectedText?.length || 0}字符`,
            );
            return {
              success: true,
              message: consumed.message,
              title: consumed.title,
              url: consumed.url,
            };
          }
          return { success: false, reason: "no pending data" };
        }

        // 清除所有快照 + pending
        if (data._action === "clear") {
          const count = pageSnapshots.length;
          pageSnapshots.length = 0;
          // 同时清除 pending 注入
          consumePendingBrowserInjection();
          diag.log("所有页面快照已清除，共清除:", count, "个");
          return { success: true };
        }

        // 获取所有快照（供前端展示）
        if (data._action === "getSnapshots") {
          return pageSnapshots.map((s) => ({
            url: s.url,
            title: s.title,
            contentLength: s.content.length,
            selectedText: s.selectedText?.substring(0, 100),
            receivedAt: s.receivedAt,
          }));
        }

        // 获取状态（前端轮询用）
        if (data._action === "getStatus") {
          const latest = getLatestSnapshot();
          return {
            snapshotCount: pageSnapshots.length,
            latestTitle: latest?.title || "",
            latestUrl: latest?.url || "",
            latestAge: latest ? Date.now() - latest.receivedAt : null,
            enabled: browserConfig.enabled,
          };
        }

        // 获取油猴脚本内容
        if (data._action === "getUserscript") {
          try {
            let script;
            if (typeof Deno !== "undefined") {
              // 使用 import.meta.resolve 获取正确的 file:// URL
              const scriptUrl = import.meta.resolve("./userscript_template.js");
              // Deno.readTextFile 支持 file:// URL（Deno 1.x+）
              // 但为安全起见，转换为文件系统路径
              const url = new URL(scriptUrl);
              let fsPath;
              if (Deno.build?.os === "windows") {
                // file:///D:/path → D:/path
                fsPath = decodeURIComponent(url.pathname).replace(/^\//, "");
              } else {
                fsPath = decodeURIComponent(url.pathname);
              }
              diag.debug("getUserscript: 读取路径:", fsPath);
              script = await Deno.readTextFile(fsPath);
              diag.log("getUserscript: 成功读取, 长度:", script.length);
            } else {
              script =
                "// userscript_template.js not available in this runtime";
            }
            return { script };
          } catch (err) {
            diag.warn("getUserscript 失败:", err.message);
            return { script: null, error: err.message };
          }
        }

        // 清除所有快照
        if (data._action === "clearSnapshots") {
          const count = pageSnapshots.length;
          pageSnapshots.length = 0;
          consumePendingBrowserInjection();
          diag.log("clearSnapshots: 清除了", count, "个快照");
          return { success: true, cleared: count };
        }

        // 启用/禁用
        if (data._action === "setEnabled") {
          browserConfig.enabled = !!data.enabled;
          diag.log("setEnabled:", browserConfig.enabled);
          return { success: true, enabled: browserConfig.enabled };
        }

        // 更新配置
        if (data._action === "updateConfig") {
          const oldConfig = { ...browserConfig };
          if (data.enabled !== undefined)
            browserConfig.enabled = !!data.enabled;
          if (data.autoInject !== undefined)
            browserConfig.autoInject = !!data.autoInject;
          if (data.maxContentLength !== undefined)
            browserConfig.maxContentLength = Math.max(
              500,
              Math.min(50000, data.maxContentLength),
            );
          if (
            data.injectMode !== undefined &&
            ["latest", "all"].includes(data.injectMode)
          )
            browserConfig.injectMode = data.injectMode;
          diag.log("配置已更新:", browserConfig);
          diag.debug("配置变更详情:", {
            before: oldConfig,
            after: browserConfig,
          });
          return { success: true, config: browserConfig };
        }
      },
    },

    chat: {
      /**
       * GetPrompt — 将页面内容注入 AI 上下文
       *
       * 注入策略（优先级从高到低）：
       * 1. 一次性 pending 注入（consumeBrowser 后存入的数据）— 用后即清，不显示在聊天界面
       * 2. 自动注入最新缓存快照（环形缓冲区中的页面内容）
       *
       * 返回 { text: [...] }，由 beilu-preset Round 2 自动收集注入到 @D0
       * @param {object} arg - chatReplyRequest_t（注意：无 AddSystemPrompt 方法）
       */
      GetPrompt: async (arg) => {
        const textEntries = [];

        // ★ 优先级 1: 一次性 pending 注入（前端 consumeBrowser 后存入的数据）
        // 这是"不显示在聊天界面、临时单次注入"的核心机制
        const pendingData = consumePendingPromptInjection();
        if (pendingData) {
          const text = formatSnapshotForAI(
            {
              url: pendingData.url,
              title: pendingData.title,
              content: pendingData.content,
              selectedText: pendingData.selectedText,
              receivedAt: pendingData.timestamp || Date.now(),
            },
            browserConfig.maxContentLength,
          );
          if (text) {
            textEntries.push({
              content: text,
              identifier: "beilu-browser-pending",
            });
            diag.log(
              "GetPrompt: ★ 一次性 pending 注入",
              `| 标题: ${pendingData.title}`,
              `| 注入长度: ${text.length}`,
              `| 消息: ${pendingData.message?.substring(0, 50) || "(无)"}`,
            );
          }
          // pending 注入是一次性的，已消费完毕，直接返回
          if (textEntries.length > 0) {
            return { text: textEntries };
          }
        }

        // ★ 优先级 2: 自动注入缓存快照（常规模式）
        if (!browserConfig.enabled || !browserConfig.autoInject) {
          diag.debug(
            "GetPrompt: 跳过自动注入 (enabled:",
            browserConfig.enabled,
            ", autoInject:",
            browserConfig.autoInject,
            ")",
          );
          return;
        }
        if (pageSnapshots.length === 0) {
          diag.debug("GetPrompt: 跳过自动注入 — 无缓存快照");
          return;
        }

        // 检查快照是否太旧（超过 30 分钟不注入）
        const latest = getLatestSnapshot();
        if (!latest) return;
        const age = Date.now() - latest.receivedAt;
        if (age > 30 * 60 * 1000) {
          diag.debug(
            "GetPrompt: 跳过自动注入 — 快照过期",
            `(${Math.floor(age / 60000)}分钟前)`,
            latest.title,
          );
          return;
        }

        if (browserConfig.injectMode === "latest") {
          const text = formatSnapshotForAI(
            latest,
            browserConfig.maxContentLength,
          );
          if (text) {
            textEntries.push({
              content: text,
              identifier: "beilu-browser-page",
            });
            diag.log(
              "GetPrompt: 已准备自动注入最新页面",
              `| 标题: ${latest.title}`,
              `| 注入长度: ${text.length}`,
              `| 年龄: ${Math.floor(age / 1000)}秒`,
            );
          }
        } else if (browserConfig.injectMode === "all") {
          const allTexts = pageSnapshots
            .slice(-3) // 最多注入最近3个
            .map((s) =>
              formatSnapshotForAI(
                s,
                Math.floor(browserConfig.maxContentLength / 3),
              ),
            )
            .filter(Boolean);
          if (allTexts.length > 0) {
            const joined = allTexts.join("\n\n---\n\n");
            textEntries.push({
              content: joined,
              identifier: "beilu-browser-pages",
            });
            diag.log(
              "GetPrompt: 已准备自动注入多个页面",
              `| 页面数: ${allTexts.length}`,
              `| 总注入长度: ${joined.length}`,
            );
          }
        }

        if (textEntries.length > 0) {
          return { text: textEntries };
        }
      },
    },
  },
};

export default pluginExport;

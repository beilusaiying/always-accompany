/**
 * Discord 机器人 shell 的客户端逻辑。
 */
import {
  confirmI18n,
  geti18n,
  i18nElement,
  initTranslations,
  promptI18n,
} from "/scripts/i18n.mjs";
import { createJsonEditor } from "/scripts/jsonEditor.mjs";
import { getPartList } from "/scripts/parts.mjs";
import { createSearchableDropdown } from "/scripts/search.mjs";
import { applyTheme } from "/scripts/theme.mjs";
import { showToast, showToastI18n } from "/scripts/toast.mjs";

import {
  clearBotContext,
  deleteBotConfig,
  getActiveChannels,
  getBotConfig,
  getBotConfigTemplate,
  getBotList,
  getMessageLog,
  getRunningBotList,
  newBotConfig,
  setBotConfig,
  setMessageLogSize,
  startBot,
  stopBot,
} from "./src/endpoints.mjs";

const configEditorContainer = document.getElementById("config-editor");

const newBotButton = document.getElementById("new-bot");
const botListDropdown = document.getElementById("bot-list-dropdown");
const deleteBotButton = document.getElementById("delete-bot");
const charSelectDropdown = document.getElementById("char-select-dropdown");
const tokenInput = document.getElementById("token-input");
const toggleTokenButton = document.getElementById("toggle-token");
const saveConfigButton = document.getElementById("save-config");
const saveStatusIcon = document.getElementById("saveStatusIcon");
const startStopBotButton = document.getElementById("start-stop-bot");
const startStopStatusIcon = document.getElementById("startStopStatusIcon");
const startStopStatusText = document.getElementById("startStopStatusText");
const clearContextButton = document.getElementById("clear-context");
const logSizeInput = document.getElementById("log-size-input");
const logStatusBadge = document.getElementById("log-status");
const messageLogContainer = document.getElementById("message-log-container");
const messageLogList = document.getElementById("message-log-list");
const messageLogEmpty = document.getElementById("message-log-empty");
const activeChannelsDiv = document.getElementById("active-channels");
const activeChannelsList = document.getElementById("active-channels-list");

// ---- 可视化配置表单元素 ----
const cfgOwner = document.getElementById("cfg-owner");
const cfgMaxDepth = document.getElementById("cfg-max-depth");
const cfgMaxFetch = document.getElementById("cfg-max-fetch");
const cfgTriggerMention = document.getElementById("cfg-trigger-mention");
const cfgTriggerMessage = document.getElementById("cfg-trigger-message");
const cfgReplyAll = document.getElementById("cfg-reply-all");
const cfgPrivateChat = document.getElementById("cfg-private-chat");
const cfgTriggerChannels = document.getElementById("cfg-trigger-channels");

let configEditor = null;
let botList = [];
let charList = [];
let selectedBot = null;
let isDirty = false; // 标记是否有未保存的更改

// ---- 消息日志状态 ----
let logPollTimer = null;
let lastLogTimestamp = 0; // 增量轮询用
let allLogEntries = []; // 当前显示的所有日志条目

/**
 * 渲染机器人下拉列表。
 * @returns {Promise<void>}
 */
async function renderBotDropdown() {
  const disabled = !botList || !botList.length;
  const dataList = disabled
    ? []
    : botList.map((name) => ({ name, value: name }));

  if (selectedBot) botListDropdown.dataset.value = selectedBot;
  else delete botListDropdown.dataset.value;

  await createSearchableDropdown({
    dropdownElement: botListDropdown,
    dataList,
    textKey: "name",
    valueKey: "value",
    disabled,
    /**
     * @param {object} selectedItem - 选定的项目。
     * @returns {Promise<boolean|undefined>} - 返回一个 Promise，解析为布尔值或 undefined。
     */
    onSelect: async (selectedItem) => {
      const botName = selectedItem ? selectedItem.value : null;
      if (botName == selectedBot) return;
      if (isDirty && !confirmI18n("discord_bots.alerts.unsavedChanges"))
        return true;
      await loadBotConfig(botName);
    },
  });
}

/**
 * 渲染角色下拉列表。
 * @returns {Promise<void>}
 */
async function renderCharDropdown() {
  i18nElement(charSelectDropdown.parentElement);
  const disabled = !charList || !charList.length;
  const dataList = disabled
    ? []
    : charList.map((name) => ({ name, value: name }));

  await createSearchableDropdown({
    dropdownElement: charSelectDropdown,
    dataList,
    textKey: "name",
    valueKey: "value",
    disabled,
    /**
     * @param {object} selectedItem - 选定的项目。
     */
    onSelect: (selectedItem) => {
      const charName = selectedItem ? selectedItem.value : null;
      if (charName) handleCharSelectChange(charName);
    },
  });
}

/**
 * 将配置对象填充到可视化表单
 * @param {object} cfg - 配置对象
 */
function populateVisualConfig(cfg) {
  cfgOwner.value = cfg.OwnerUserName || "";
  cfgMaxDepth.value = cfg.MaxMessageDepth ?? 20;
  cfgMaxFetch.value = cfg.MaxFetchCount ?? 30;
  cfgTriggerMention.checked = cfg.TriggerOnMention !== false;
  cfgTriggerMessage.checked = !!cfg.TriggerOnMessage;
  cfgReplyAll.checked = !!cfg.ReplyToAllMessages;
  cfgPrivateChat.checked = cfg.PrivateChatEnabled !== false;
  cfgTriggerChannels.value = (cfg.TriggerChannels || []).join(", ");
}

/**
 * 从可视化表单读取配置对象
 * @returns {object} 配置对象
 */
function readVisualConfig() {
  return {
    OwnerUserName: cfgOwner.value.trim(),
    MaxMessageDepth: parseInt(cfgMaxDepth.value) || 20,
    MaxFetchCount: parseInt(cfgMaxFetch.value) || 30,
    ReplyToAllMessages: cfgReplyAll.checked,
    TriggerOnMention: cfgTriggerMention.checked,
    TriggerOnMessage: cfgTriggerMessage.checked,
    TriggerChannels: cfgTriggerChannels.value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    PrivateChatEnabled: cfgPrivateChat.checked,
  };
}

/**
 * 可视化表单 → JSON 编辑器同步
 */
function syncVisualToEditor() {
  if (!configEditor) return;
  const visualCfg = readVisualConfig();
  // 合并：保留编辑器中的额外字段，覆盖已知字段
  try {
    const editorData =
      configEditor.get().json || JSON.parse(configEditor.get().text || "{}");
    const merged = { ...editorData, ...visualCfg };
    configEditor.set({ json: merged });
  } catch {
    configEditor.set({ json: visualCfg });
  }
  isDirty = true;
}

/**
 * 加载机器人配置。
 * @param {string} botname - 机器人名称。
 * @returns {Promise<void>}
 */
async function loadBotConfig(botname) {
  selectedBot = botname;

  if (!botname) {
    tokenInput.value = "";
    charSelectDropdown.dataset.value = "";
    populateVisualConfig({});
    if (configEditor) configEditor.set({ json: {} });
    isDirty = false;
    await updateStartStopButtonState();
    return;
  }

  try {
    const config = await getBotConfig(botname);
    tokenInput.value = config.token || "";

    charSelectDropdown.dataset.value = config.char || "";

    if (config.char && !Object.keys(config.config).length) {
      const template = await getBotConfigTemplate(config.char);
      if (template) config.config = template;
    }

    // 填充可视化表单
    populateVisualConfig(config.config || {});

    if (!configEditor)
      configEditor = createJsonEditor(configEditorContainer, {
        label: geti18n("discord_bots.configCard.labels.config"),
        onChange: (updatedContent, previousContent, { error, patchResult }) => {
          if (!error) isDirty = true;
        },
        onSave: handleSaveConfig,
      });

    configEditor.set({ json: config.config || {} });
    isDirty = false;

    await updateStartStopButtonState();
  } catch (error) {
    console.error(error);
  }
}

/**
 * 处理新建机器人。
 * @returns {Promise<void>}
 */
async function handleNewBot() {
  const botname = promptI18n("discord_bots.prompts.newBotName")?.trim();
  if (!botname) return;

  if (botList.includes(botname)) {
    showToastI18n("error", "discord_bots.alerts.botExists", { botname });
    return;
  }

  try {
    await newBotConfig(botname);
    botList = await getBotList();
    await renderBotDropdown();
    botListDropdown.dataset.value = botname;
    await loadBotConfig(botname);
  } catch (error) {
    console.error(error);
  }
}

/**
 * 处理删除机器人。
 * @returns {Promise<void>}
 */
async function handleDeleteBot() {
  if (!selectedBot) return;

  if (isDirty) if (!confirmI18n("discord_bots.alerts.unsavedChanges")) return;

  try {
    const oldBotIndex = botList.indexOf(selectedBot);
    await deleteBotConfig(selectedBot);
    botList = await getBotList();

    let nextBotToLoad = null;
    if (botList.length) {
      const newIndex = Math.min(oldBotIndex, botList.length - 1);
      nextBotToLoad = botList[newIndex];
    }

    await loadBotConfig(nextBotToLoad);
    await renderBotDropdown();
  } catch (error) {
    console.error(error);
  }
}

/**
 * 处理角色选择更改。
 * @param {string} selectedChar - 选定的角色。
 * @returns {Promise<void>}
 */
async function handleCharSelectChange(selectedChar) {
  if (isDirty && !confirmI18n("discord_bots.alerts.unsavedChanges")) return;

  if (!selectedChar) return (charSelectDropdown.dataset.value = "");
  isDirty = true;
  const template = await getBotConfigTemplate(selectedChar);
  if (template) {
    populateVisualConfig(template);
    if (configEditor) configEditor.set({ json: template });
  }
}

/**
 * 处理切换令牌可见性。
 */
function handleToggleToken() {
  tokenInput.type = tokenInput.type === "password" ? "text" : "password";
  toggleTokenButton.innerHTML = /* html */ `<img src="https://api.iconify.design/line-md/watch${tokenInput.type === "password" ? "-off" : ""}.svg" class="text-icon" data-i18n="discord_bots.configCard.toggleApiKeyIcon" />`;
  i18nElement(toggleTokenButton);
}

/**
 * 处理保存配置。
 * @returns {Promise<void>}
 */
async function handleSaveConfig() {
  if (!selectedBot) return;

  // 合并可视化配置和 JSON 编辑器中的额外字段
  let editorConfig = {};
  try {
    editorConfig =
      configEditor?.get()?.json ||
      JSON.parse(configEditor?.get()?.text || "{}");
  } catch {
    /* ignore */
  }
  const visualCfg = readVisualConfig();
  const mergedConfig = { ...editorConfig, ...visualCfg };

  const config = {
    token: tokenInput.value,
    char: charSelectDropdown.dataset.value,
    config: mergedConfig,
  };

  saveStatusIcon.src = "https://api.iconify.design/line-md/loading-loop.svg";
  saveStatusIcon.classList.remove("hidden");
  saveConfigButton.disabled = true;

  try {
    await setBotConfig(selectedBot, config);
    showToastI18n("success", "discord_bots.alerts.configSaved");
    isDirty = false;

    saveStatusIcon.src =
      "https://api.iconify.design/line-md/confirm-circle.svg";
  } catch (error) {
    showToast(
      "error",
      error.message + "\n" + error.error || error.errors?.join("\n") || "",
    );
    console.error(error);

    saveStatusIcon.src = "https://api.iconify.design/line-md/emoji-frown.svg";
  }

  setTimeout(() => {
    saveStatusIcon.classList.add("hidden");
    saveConfigButton.disabled = false;
  }, 2000);
}

/**
 * 处理启动/停止机器人。
 * @returns {Promise<void>}
 */
async function handleStartStopBot() {
  if (!selectedBot) return;

  startStopStatusIcon.src =
    "https://api.iconify.design/line-md/loading-loop.svg";
  startStopStatusIcon.classList.remove("hidden");
  startStopBotButton.disabled = true;

  try {
    const runningBots = await getRunningBotList();
    const isRunning = runningBots.includes(selectedBot);
    if (isRunning) {
      await stopBot(selectedBot);
      startStopStatusText.dataset.i18n =
        "discord_bots.configCard.buttons.startBot";
      startStopBotButton.classList.remove("btn-error");
      startStopBotButton.classList.add("btn-success");
    } else {
      await startBot(selectedBot);
      startStopStatusText.dataset.i18n =
        "discord_bots.configCard.buttons.stopBot";
      startStopBotButton.classList.remove("btn-success");
      startStopBotButton.classList.add("btn-error");
    }

    startStopStatusIcon.src =
      "https://api.iconify.design/line-md/confirm-circle.svg";
  } catch (error) {
    showToast(
      "error",
      error.message + "\n" + error.error || error.errors?.join("\n") || "",
    );
    console.error(error);

    startStopStatusIcon.src =
      "https://api.iconify.design/line-md/emoji-frown.svg";
  }

  setTimeout(() => {
    startStopStatusIcon.classList.add("hidden");
    startStopBotButton.disabled = false;
  }, 2000);
}

/**
 * 更新启动/停止按钮状态。
 * @returns {Promise<void>}
 */
async function updateStartStopButtonState() {
  if (!selectedBot) {
    startStopStatusText.dataset.i18n =
      "discord_bots.configCard.buttons.startBot";
    startStopBotButton.classList.remove("btn-error");
    startStopBotButton.classList.add("btn-success");
    return;
  }
  try {
    const runningBots = await getRunningBotList();
    if (runningBots.includes(selectedBot)) {
      startStopStatusText.dataset.i18n =
        "discord_bots.configCard.buttons.stopBot";
      startStopBotButton.classList.remove("btn-success");
      startStopBotButton.classList.add("btn-error");
    } else {
      startStopStatusText.dataset.i18n =
        "discord_bots.configCard.buttons.startBot";
      startStopBotButton.classList.remove("btn-error");
      startStopBotButton.classList.add("btn-success");
    }
  } catch (error) {
    console.error("Failed to update start/stop button state:", error);
  }
}

/**
 * 获取 URL 参数。
 * @returns {URLSearchParams} - URL 参数。
 */
function getURLParams() {
  return new URLSearchParams(window.location.search);
}

/**
 * 从 URL 参数初始化。
 * @returns {Promise<void>}
 */
async function initializeFromURLParams() {
  const urlParams = getURLParams();
  const botName = urlParams.get("name");
  const charName = urlParams.get("char");

  try {
    // 1. Fetch lists
    botList = await getBotList();
    charList = await getPartList("chars");

    // 2. Render the dropdowns with the lists
    await renderBotDropdown();
    await renderCharDropdown();

    // 3. Determine which bot to load
    let botToLoad = null;
    if (botName && botList.includes(botName)) botToLoad = botName;
    else if (botName && !botList.includes(botName))
      // If bot from URL doesn't exist, create it
      try {
        await newBotConfig(botName);
        botList = await getBotList();
        renderBotDropdown(); // re-render with new list
        botToLoad = botName;
      } catch (error) {
        console.error("Failed to create new bot from URL parameter:", error);
      }
    else if (botList.length) botToLoad = botList[0];

    // 4. Load the bot if one was determined
    if (botToLoad) {
      // Set the dropdown value and load the config
      botListDropdown.dataset.value = botToLoad;
      await loadBotConfig(botToLoad);
    }

    // 5. Set the character from URL param, this has precedence
    if (charName) charSelectDropdown.dataset.value = charName;
  } catch (error) {
    console.error("Failed to initialize from URL parameters:", error);
  }
}

// ============================================================
// 消息日志轮询与渲染
// ============================================================

/**
 * 开始消息日志轮询
 */
function startLogPolling() {
  stopLogPolling();
  lastLogTimestamp = 0;
  allLogEntries = [];
  messageLogList.innerHTML = "";
  messageLogEmpty.classList.remove("hidden");
  logStatusBadge.textContent = "轮询中";
  logStatusBadge.className = "badge badge-info";

  // 立即拉取一次
  pollMessageLog();
  // 每3秒轮询
  logPollTimer = setInterval(pollMessageLog, 3000);
}

/**
 * 停止消息日志轮询
 */
function stopLogPolling() {
  if (logPollTimer) {
    clearInterval(logPollTimer);
    logPollTimer = null;
  }
  logStatusBadge.textContent = "未连接";
  logStatusBadge.className = "badge badge-ghost";
}

/**
 * 轮询消息日志（增量）
 */
async function pollMessageLog() {
  if (!selectedBot) return;
  try {
    const runningBots = await getRunningBotList();
    if (!runningBots.includes(selectedBot)) {
      logStatusBadge.textContent = "Bot 未运行";
      logStatusBadge.className = "badge badge-warning";
      return;
    }
    logStatusBadge.textContent = "运行中";
    logStatusBadge.className = "badge badge-success";

    const data = await getMessageLog(
      selectedBot,
      lastLogTimestamp || undefined,
    );
    if (data.logs && data.logs.length > 0) {
      for (const entry of data.logs) {
        allLogEntries.push(entry);
        renderLogEntry(entry);
        if (entry.timestamp > lastLogTimestamp) {
          lastLogTimestamp = entry.timestamp;
        }
      }
      messageLogEmpty.classList.add("hidden");
      // 自动滚动到底部
      messageLogContainer.scrollTop = messageLogContainer.scrollHeight;
    }
    if (data.maxSize && logSizeInput.value !== String(data.maxSize)) {
      logSizeInput.value = data.maxSize;
    }

    // 更新活跃频道
    try {
      const channels = await getActiveChannels(selectedBot);
      if (channels && channels.length > 0) {
        activeChannelsDiv.classList.remove("hidden");
        activeChannelsList.innerHTML = channels
          .map(
            (ch) =>
              `<span class="badge badge-outline badge-sm">${ch.channelId} (${ch.messageCount}条)</span>`,
          )
          .join("");
      } else {
        activeChannelsDiv.classList.add("hidden");
      }
    } catch (e) {
      /* ignore */
    }
  } catch (error) {
    logStatusBadge.textContent = "错误";
    logStatusBadge.className = "badge badge-error";
  }
}

/**
 * 渲染单条日志
 * @param {object} entry - 日志条目
 */
function renderLogEntry(entry) {
  const div = document.createElement("div");
  const typeClass =
    entry.type === "user"
      ? "msg-user"
      : entry.type === "error"
        ? "msg-error"
        : "msg-ai";
  div.className = `msg-log-entry ${typeClass}`;
  div.dataset.id = entry.id;

  const timeStr = new Date(entry.timestamp).toLocaleTimeString();
  const typeIcon =
    entry.type === "user" ? "👤" : entry.type === "error" ? "⚠️" : "🤖";
  const fileInfo = entry.files ? ` 📎${entry.files}` : "";

  let html = `<div class="msg-header">
    <span>${typeIcon}</span>
    <span class="msg-author">${escapeHtml(entry.author || "")}</span>
    <span class="msg-channel">${escapeHtml(entry.channelName || "")}</span>
    <span>${timeStr}${fileInfo}</span>
  </div>
  <div class="msg-content">${escapeHtml(entry.content || "")}</div>`;

  // AI 回复的思维链展开
  if (entry.type === "ai" && entry.thinking) {
    const thinkingId = `think-${entry.id}`;
    html += `<div class="msg-thinking-toggle" onclick="document.getElementById('${thinkingId}').classList.toggle('hidden')">💭 展开思维链</div>
    <div id="${thinkingId}" class="msg-thinking hidden">${escapeHtml(entry.thinking)}</div>`;
  }

  // AI 回复的原始完整内容展开
  if (entry.type === "ai" && entry.fullContent) {
    const fullId = `full-${entry.id}`;
    html += `<div class="msg-thinking-toggle" onclick="document.getElementById('${fullId}').classList.toggle('hidden')">📄 展开原始内容</div>
    <div id="${fullId}" class="msg-thinking hidden">${escapeHtml(entry.fullContent)}</div>`;
  }

  div.innerHTML = html;
  messageLogList.appendChild(div);
}

/**
 * HTML 转义
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

/**
 * 处理日志条数变更
 */
async function handleLogSizeChange() {
  if (!selectedBot) return;
  const size = parseInt(logSizeInput.value) || 20;
  try {
    await setMessageLogSize(selectedBot, size);
  } catch (e) {
    console.error("设置日志条数失败:", e);
  }
}

// ============================================================
// 初始化
// ============================================================

/**
 * 初始化应用程序。
 * @returns {Promise<void>}
 */
async function init() {
  applyTheme();
  await initTranslations("discord_bots");
  initializeFromURLParams();

  // 事件监听
  newBotButton.addEventListener("click", handleNewBot);
  deleteBotButton.addEventListener("click", handleDeleteBot);
  toggleTokenButton.addEventListener("click", handleToggleToken);
  saveConfigButton.addEventListener("click", handleSaveConfig);
  startStopBotButton.addEventListener("click", handleStartStopBot);
  clearContextButton.addEventListener("click", handleClearContext);
  logSizeInput.addEventListener("change", handleLogSizeChange);

  // 可视化表单变化时同步到 JSON 编辑器并标记 dirty
  for (const el of [cfgOwner, cfgMaxDepth, cfgMaxFetch, cfgTriggerChannels]) {
    el.addEventListener("input", () => {
      syncVisualToEditor();
    });
  }
  for (const el of [
    cfgTriggerMention,
    cfgTriggerMessage,
    cfgReplyAll,
    cfgPrivateChat,
  ]) {
    el.addEventListener("change", () => {
      syncVisualToEditor();
    });
  }

  // 离开页面时停止轮询 + 未保存提醒（不自动清除上下文，由用户手动操作）
  window.addEventListener("beforeunload", (event) => {
    stopLogPolling();
    if (isDirty) {
      event.preventDefault();
      event.returnValue = geti18n("discord_bots.alerts.beforeUnload");
    }
  });

  // Bot 选择变化时启动/停止轮询
  startLogPolling();
}

/**
 * 处理清除上下文。
 * @returns {Promise<void>}
 */
async function handleClearContext() {
  if (!selectedBot) return;
  if (
    !confirm(
      "确定要清除所有频道的聊天上下文吗？\n（记忆表格将保留，消息日志也会清除）",
    )
  )
    return;

  clearContextButton.disabled = true;
  try {
    const result = await clearBotContext(selectedBot);
    showToast(
      "success",
      `上下文已清除（${result.clearedChannels || 0} 个频道）`,
    );
    // 重置消息日志显示
    allLogEntries = [];
    lastLogTimestamp = 0;
    messageLogList.innerHTML = "";
    messageLogEmpty.classList.remove("hidden");
  } catch (error) {
    showToast("error", error.message);
    console.error(error);
  } finally {
    clearContextButton.disabled = false;
  }
}

init();

/**
 * 创建新聊天的页面逻辑。
 * 先检查该角色是否已有聊天记录，如果有则直接跳转到最近的聊天；
 * 否则创建新聊天会话，添加角色后重定向到 beilu-chat 主页面。
 */
import { console, initTranslations } from "../../../scripts/i18n.mjs";
import { applyTheme } from "../../../scripts/theme.mjs";
import { showToast } from "../../../scripts/toast.mjs";
import {
  addCharacter,
  createNewChat,
  currentChatId,
} from "../src/endpoints.mjs";

/**
 * 带超时的 fetch 封装
 * @param {string} url
 * @param {RequestInit} [options]
 * @param {number} [timeoutMs=8000]
 * @returns {Promise<Response>}
 */
function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() =>
    clearTimeout(timer),
  );
}

/**
 * 给 addCharacter 增加超时保护，避免 /new 页面在异常网络或后端挂起时长期 spinner。
 * @param {string} charName
 * @param {number} [timeoutMs=12000]
 * @returns {Promise<any>}
 */
async function addCharacterWithTimeout(charName, timeoutMs = 12000) {
  return Promise.race([
    addCharacter(charName),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`addCharacter timeout after ${timeoutMs}ms`)),
        timeoutMs,
      ),
    ),
  ]);
}

/**
 * 查询该角色是否已有聊天记录。
 * @param {string} charName - 角色名称
 * @returns {Promise<string|null>} - 已有聊天的 chatid，没有则返回 null
 */
async function findExistingChat(charName) {
  try {
    const response = await fetchWithTimeout(
      "/api/parts/shells:chat/getchatlist",
    );
    if (!response.ok) return null;
    const chatList = await response.json();
    // chatList 是按时间倒序排列的摘要数组，找到第一个包含该角色的聊天
    const existing = chatList.find(
      (chat) => Array.isArray(chat.chars) && chat.chars.includes(charName),
    );
    return existing?.chatid || null;
  } catch (e) {
    console.warn("[new] 查询已有聊天失败:", e.message);
    return null;
  }
}

/**
 * 初始化页面，检查已有聊天或创建新聊天会话，然后重定向到 beilu-chat 主页面。
 * @returns {Promise<void>}
 */
async function main() {
  await initTranslations("chat.new");
  applyTheme();

  const searchParams = new URLSearchParams(window.location.search);
  const charToAdd = searchParams.get("char");
  console.log(
    "[new][DIAG] main 开始, charToAdd:",
    charToAdd,
    "location:",
    window.location.href,
  );

  try {
    // 如果指定了角色，先检查是否已有该角色的聊天
    if (charToAdd) {
      const existingChatId = await findExistingChat(charToAdd);
      console.log("[new][DIAG] findExistingChat 结果:", existingChatId);
      if (existingChatId) {
        // P0 修复：跳转前验证该 chatid 对应的聊天是否真的有效
        try {
          const checkRes = await fetch(
            `/api/parts/shells:chat/${existingChatId}/initial-data`,
          );
          console.log("[new][DIAG] initial-data 验证结果:", checkRes.status);
          if (checkRes.ok) {
            // 聊天有效，直接跳转
            console.log(
              `[new] 角色 "${charToAdd}" 已有聊天 ${existingChatId}，验证通过，直接跳转`,
            );
            const target = "/parts/shells:beilu-chat/#" + existingChatId;
            console.log("[new][DIAG] 即将跳转到:", target);
            window.location.replace(target);
            return;
          }
          // 聊天无效（404），继续创建新聊天
          console.warn(
            `[new] 角色 "${charToAdd}" 的历史聊天 ${existingChatId} 已失效，创建新聊天`,
          );
        } catch (checkErr) {
          console.warn(
            `[new] 验证聊天 ${existingChatId} 失败:`,
            checkErr.message,
            "，创建新聊天",
          );
        }
      }
    }

    // 没有已有聊天，创建新的
    await createNewChat();
    if (charToAdd) {
      try {
        await addCharacterWithTimeout(charToAdd, 12000);
      } catch (addErr) {
        console.warn(
          `[new][DIAG] addCharacter 超时或失败: chatId=${currentChatId} char=${charToAdd}`,
          addErr.message,
        );
        showToast(
          "warning",
          `角色加入聊天超时，已先进入聊天页面（${addErr.message}）`,
        );
      }
    }
  } catch (e) {
    console.error(e);
    showToast("error", e.stack || e.message || e);
    throw e;
  }

  const target = "/parts/shells:beilu-chat/#" + currentChatId;
  console.log(
    "[new][DIAG] 新建聊天完成，即将跳转到:",
    target,
    "currentChatId:",
    currentChatId,
  );
  window.location.replace(target);
}
main();

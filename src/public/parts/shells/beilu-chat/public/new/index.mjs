/**
 * 创建新聊天的页面逻辑。
 * 先检查该角色是否已有聊天记录，如果有则直接跳转到最近的聊天；
 * 否则创建新聊天会话，添加角色后重定向到 beilu-chat 主页面。
 */
import { console, initTranslations } from "../../../../../scripts/i18n.mjs";
import { applyTheme } from "../../../../../scripts/theme.mjs";
import { showToast } from "../../../../../scripts/toast.mjs";
import {
  addCharacter,
  createNewChat,
  currentChatId,
} from "../src/shared/transport/endpoints.mjs";
// T2批23：/new 页两条读路（getchatlist 存在性查询 + initial-data 有效性校验）已收口到 sendAction 门面
//   （getChatList / getInitialData）——原 apiFetch 直连（R1 收口的 fetchWithTimeout 轮子替代）已无本体消费者，
//   apiFetch import 随之移除（createNewChat/addCharacter 内部自有 apiFetch，不经本文件）。
//   getInitialData 注册体带 timeout:8000（原直连 timeout 经门面透传保留）+ notify:"report"（后台校验失败进报错系统不弹 toast）。
import { sendAction } from "../src/shared/transport/sendAction.mjs";
// [D7 收口 0713] 角色↔对话归属判断接单一权威（utils 纯函数层,不拉 chat.mjs 重链）。
//   原手抄 chars.includes 漏 primaryCharName 判断+bot(🤖)排除 → 跨角色/bot 线误命中已有对话。
import { chatBelongsToChar } from "../src/shared/state/utils.mjs";

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
    // T2批23：走 getChatList（凛倾清单指定，缺省 toast）。sendAction 直返 body（非 2xx 自动 throw 进 catch → 返 null，
    //   与原 if(!response.ok) return null 等价）。catch 内已主动弹 warning toast 告知"将新建对话"（原有设计意图保留）。
    const chatList = await sendAction({ verb: "getChatList", target: "shells:chat", source: "web" });
    // chatList 是按时间倒序排列的摘要数组，找到第一个属于该角色的聊天（chatBelongsToChar 单一权威）
    const existing = chatList.find((chat) => chatBelongsToChar(chat, charName));
    return existing?.chatid || null;
  } catch (e) {
    console.warn("[new] 查询已有聊天失败:", e.message);
    // T021 弹出：失败静默返 null 会直接走"新建对话"分支——用户可能因此多出重复对话，须知情
    showToast("warning", "查询已有对话失败（将新建对话）: " + (e?.message || e));
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
        // T2批23：走 getInitialData（notify:"report" + timeout:8000 经门面透传）。sendAction 成功=聊天有效直接跳转；
        //   失败（含 404 无效聊天，非 2xx 自动 throw）进 catch → 继续新建（与原 if(ok)跳转/else|catch 新建 等价合并）。
        try {
          await sendAction({ verb: "getInitialData", target: "shells:chat", source: "web", scope: { chatId: existingChatId } });
          // 聊天有效，直接跳转
          console.log(
            `[new] 角色 "${charToAdd}" 已有聊天 ${existingChatId}，验证通过，直接跳转`,
          );
          const target = "/parts/shells:beilu-chat/#" + existingChatId;
          console.log("[new][DIAG] 即将跳转到:", target);
          window.location.replace(target);
          return;
        } catch (checkErr) {
          // 聊天无效（404）或校验失败：静默降级继续新建（getInitialData notify:"report" 已进报错系统，不弹 toast）
          console.warn(
            `[new] 验证聊天 ${existingChatId} 失败或已失效:`,
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

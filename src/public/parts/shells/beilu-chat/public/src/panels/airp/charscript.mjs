/**
 * @file charscript.mjs — 角色卡脚本系统 cluster
 *
 * 【用户视角功能】
 *   角色卡内嵌的脚本（自定义UI按钮、消息处理钩子）在隔离iframe中自动运行。
 *   切角色/切预设/手动启禁脚本 → 对应脚本立即重载。
 *
 * 【功能链 — 用户操作 → 传导 → 效果】
 *   页面加载 → initCharacterScriptSystem → _loadScriptsForChar(charId) → iframe注入
 *   用户切角色 → switchCharacterScope dispatch beilu:char-changed
 *     → 本模块监听 → _loadScriptsForChar(newCharId) → 旧脚本卸载 + 新脚本加载
 *   用户切预设 → WS dispatch beilu:preset-changed → _loadScriptsForPreset
 *   手动启禁脚本 → beilu:scripts-changed → 按scope分派（character/preset/global）
 *
 * 【why — 三种事件分工】
 *   beilu:char-changed = 角色变了，重载character scope脚本
 *   beilu:preset-changed = 预设变了，重载preset scope脚本
 *   beilu:scripts-changed = 用户手动启禁，按scope精确重载
 *
 * 【关联链】
 *   上游：index.mjs init()、beilu:char-changed、beilu:preset-changed、beilu:scripts-changed
 *   下游：scriptRunner.mjs（iframe生命周期管理）、variableStore.mjs（角色变量空间隔离）
 *
 * 【影响范围】
 *   角色脚本iframe内所有行为（UI注入、消息钩子、变量初始化）
 */
import { getCurrentCharId, waitForCharIdReady } from "./utils.mjs";
import { whenVisible } from "../../shared/state/utils.mjs"; // 0718 可见性门控
import { personaName } from "../../shared/chat-core/chat.mjs";
import { currentChatId } from "../../shared/transport/endpoints.mjs";
import { updateContext as updateVarContext } from "../../stCompat/variableStore.mjs";
import { getQueue } from "../../shared/render/virtualQueue.mjs";
import { sendAction } from "../../shared/transport/sendAction.mjs"; // T6b批7：出向统一门面（verb=真动作），char-data + beilu-memory readUserFile 收口
import { loadCharacterScripts, loadPresetScripts, loadGlobalScripts } from "../../stCompat/scriptRunner.mjs";

// ============================================================
// 角色卡脚本系统（tavern_helper 脚本 iframe）
// ============================================================

/**
 * 初始化角色卡脚本系统
 * 从当前角色卡中提取 tavern_helper.scripts 并在隐藏 iframe 中执行
 */
async function initCharacterScriptSystem() {
  const charId = getCurrentCharId();
  if (!charId) {
    // charList 可能还没加载好，用共享 polling 等待
    waitForCharIdReady(id => _loadScriptsForChar(id));
    return;
  }
  await _loadScriptsForChar(charId);
}

/**
 * 为指定角色卡加载脚本
 * @param {string} charId - 角色卡 ID
 */
// [0716 竞态修] 加载序号令牌（与 subModePanel._modelSelectReqId 同范式）：本函数含 getCharData
//   网络请求 + 最长 5s 的 getQueue 重试循环——快速切角色 A→B 时 A 的慢加载后至，会把 A 的脚本
//   注入 iframe 覆盖 B 已加载的（旧角色脚本跑在新角色会话上）。每个慢节点后比对序号，旧加载丢弃。
let _charScriptLoadSeq = 0;
async function _loadScriptsForChar(charId) {
  const _seq = ++_charScriptLoadSeq;
  // 角色隔离：更新变量存储上下文，切换到该角色的 character 变量空间
  try {
    updateVarContext({ charId, chatId: currentChatId || "" });
  } catch (e) {
    console.warn("[beilu-chat] updateVarContext 失败（非致命）:", e.message);
    // T021 弹出：脚本继续可跑（非致命）但变量隔离失效=脚本可能读写错角色的变量空间，用户须知
    window._beiluToast?.("角色变量上下文切换失败（脚本变量隔离可能失效）: " + (e?.message || e), "warning");
  }

  try {
    // 通过 char-data API 获取完整 chardata.json
    // 不能用 getPartDetails()，因为它只返回展示信息（name/avatar/description），不含 chardata
    // T6b批7：GET /char-data/:charId → sendAction shells:chat#getCharData。!ok 由门面抛错走本函数外层 catch（原 !resp.ok warn+return 等价：不加载脚本）。
    // T2批23：外层 catch 是 console.warn 静默降级（加载脚本失败=次要），凛倾拍板读路降 toast → 用 getCharDataQuiet（notify:"report"，失败进报错系统不弹 toast）。
    const charData = await sendAction({ verb: "getCharDataQuiet", target: "shells:chat", source: "web", payload: { charId } });
    if (_seq !== _charScriptLoadSeq) return; // 期间已切别的角色，丢弃旧加载
    if (!charData || typeof charData !== "object") return;

    const charName = charData.name || charId;
    const userName = personaName || "User";

    // 获取当前聊天消息队列，传入脚本 iframe 用于 SillyTavern.chat 初始化
    // MVU variable_init 需要 chat 数组非空才能进行变量初始化
    let chatMessages = [];
    try {
      chatMessages = getQueue();
      // 如果 queue 还没有数据（virtualList 异步加载中），等待一段时间重试
      if (!chatMessages || chatMessages.length === 0) {
        for (let retry = 0; retry < 5; retry++) {
          await new Promise((r) => setTimeout(r, 1000));
          if (_seq !== _charScriptLoadSeq) return; // 重试等待期间已切角色，提前退出
          chatMessages = getQueue();
          if (chatMessages && chatMessages.length > 0) break;
        }
      }
      // ★ 修复：如果 getQueue() 始终为空（virtualList 时序问题），
      // 直接从后端 API 获取 chatLog 作为 fallback
      if (!chatMessages || chatMessages.length === 0) {
        console.warn(
          "[beilu-chat] getQueue() 仍为空，尝试从后端 API 获取 chatLog...",
        );
        try {
          const { getChatLog, getChatLogLength } =
            await import("../../shared/transport/endpoints.mjs");
          const logLen = await getChatLogLength();
          if (logLen > 0) {
            chatMessages = await getChatLog(0, logLen);
            console.log(
              `[beilu-chat] 从后端 API 获取到 ${chatMessages.length} 条消息（fallback）`,
            );
          }
        } catch (apiErr) {
          console.warn(
            "[beilu-chat] 后端 API fallback 也失败:",
            apiErr.message,
          );
        }
      }
      console.log(
        `[beilu-chat] chatMessages for script system: ${chatMessages?.length || 0} messages`,
      );
    } catch (e) {
      console.warn(
        "[beilu-chat] getQueue failed for script system:",
        e.message,
      );
    }

    if (_seq !== _charScriptLoadSeq) { console.log(`[beilu-chat] 丢弃过期的角色脚本加载: ${charId}`); return; } // 注入前最终守卫
    await loadCharacterScripts(charData, {
      userName,
      charName,
      charId,
      chatId: currentChatId || "",
      chatMessages,
    });
    console.log(`[beilu-chat] 角色卡脚本系统已加载: ${charId}`);
  } catch (err) {
    console.warn(`[beilu-chat] 加载角色卡脚本失败: ${charId}`, err.message);
  }
}

// 切预设时加载预设作用域脚本(scriptRunner 不依赖预设存储,由本层读激活预设数据传入)
// [0807 §七#6 preset 半"导出即丢"] per-preset 化：真源=激活预设文件 preset_json.extensions
//   .tavern_helper.scripts（对齐酒馆助手 PresetSettings.scripts；getData 桥自动注入 chatid →
//   后端解析本窗口线激活预设，与 scriptManager/variableStore 同读源）。字段缺席（预设从未写过）
//   → 旧单份 preset_scripts.json 迁移读兜底（不再写入）。scripts=[] 也必须走 loadPresetScripts：
//   它入口先 unloadScriptsByScope('preset')——切到无脚本预设时旧预设脚本才会被卸载。
async function _loadScriptsForPreset() {
  try {
    let scripts = null;
    try {
      const pd = await sendAction({ verb: "getData", target: "plugins:beilu-preset", source: "web" });
      const th = pd?.preset_json?.extensions?.tavern_helper;
      if (th && Object.prototype.hasOwnProperty.call(th, "scripts")) {
        scripts = Array.isArray(th.scripts) ? th.scripts : [];
      }
    } catch (e) {
      console.warn("[beilu-chat] 读取预设内脚本失败（走旧文件兜底）:", e.message);
    }
    if (scripts === null) {
      // T6b批7：beilu-memory setdata {_action:readUserFile} → sendAction beilu-memory#*（通配组装 {_action:verb,...payload}）。
      const j = await sendAction({ verb: "readUserFile", target: "plugins:beilu-memory", source: "web", payload: { filename: "preset_scripts.json" } });
      let data = null;
      try { data = (j.success && j.content) ? JSON.parse(j.content) : null; }
      catch { data = null; }
      scripts = Array.isArray(data?.scripts) ? data.scripts : [];
    }
    await loadPresetScripts(
      { scripts },
      {
        userName: personaName || "User",
        charName: "",
        charId: "",
        chatId: currentChatId || "",
        chatMessages: getQueue() || [],
      },
    );
  } catch (e) {
    console.warn("[beilu-chat] 加载预设脚本失败（非致命）:", e.message);
  }
}

// 切角色时重载角色脚本：switchCharacterScope dispatch beilu:char-changed → 卸载旧脚本 + 加载新角色脚本
window.addEventListener("beilu:char-changed", whenVisible("#center-tab-editor", (e) => {
  const charId = e.detail?.charId;
  if (charId) _loadScriptsForChar(charId);
}));

window.addEventListener("beilu:preset-changed", whenVisible("#center-tab-editor", () => {
  _loadScriptsForPreset();
}));

window.addEventListener("beilu:scripts-changed", (e) => {
  const { scope, charId } = e.detail || {};
  if (scope === "character" && charId) _loadScriptsForChar(charId);
  else if (scope === "preset") _loadScriptsForPreset();
  else if (scope === "global") loadGlobalScripts();
});

export { initCharacterScriptSystem, _loadScriptsForPreset };

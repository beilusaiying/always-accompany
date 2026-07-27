/**
 * @file chatmgmt.mjs — 会话管理（扩展菜单操作）cluster
 *
 * 【功能链】
 *   navigateToChat（切卡免刷：switchCharacterScope 运行时切换，不再 location.reload）
 *   → handleNewChat（POST /api/.../new 创建聊天，失败时 _rollbackNewChat 回滚）
 *   → handleManageChats / showChatManagerModal（Modal 列出所有对话，支持改名/切换）
 *   → handleBatchDelete / showBatchDeleteModal（批量删除对话，beiluConfirm 确认）
 *   → handleRegenerate（重生成最后一条 AI 消息，deleteMessage + modifyTimeLine）
 *   → _loadConvMeta / _deleteConvMetaEntry（薄壳接 conversationManager 元数据单源；
 *     改名提交走 commitChatRename 单源 [D2 0713]）
 *
 * 【why】
 *   扩展菜单的会话操作逻辑集中在此，避免 index.mjs 膨胀；
 *   切卡免刷替代整页刷新，减少 WS 重连开销；
 *   会话元数据单独存 localStorage 供其他模块读取会话标题等信息。
 *
 * 【关联链】
 *   上游：index.mjs（init 时注册扩展菜单点击 handler）
 *   同层依赖：utils.mjs（escapeHtml / showToast）
 *   核心依赖：shared/chat-core/chat.mjs（switchCharacterScope / charList / chatBelongsToChar）、
 *             shared/transport/endpoints.mjs（currentChatId / deleteMessage / modifyTimeLine）、
 *             shared/render/virtualQueue.mjs（getChatLogIndexByQueueIndex / getQueue）、
 *             shared/widgets/beiluDialog.mjs（beiluConfirm）、
 *             panels/feature/featureControls.mjs（getModeChatIdKey / MODE_CHATID_KEYS）、
 *             shared/state/storage.mjs（storage / KEYS）；改名提交=conversationManager.commitChatRename 单源
 *
 * 【影响范围】
 *   扩展菜单中"新建/管理/批量删除/重新生成"四类操作全部走此模块；
 *   元数据写经 conversationManager 单源（BEILU_CONVERSATION_META），影响所有读取会话元数据的消费方。
 *
 * 【使用效果】
 *   import { navigateToChat, handleNewChat, handleManageChats,
 *            handleBatchDelete, handleRegenerate } from "./chatmgmt.mjs"
 *   切卡后无页面刷新，WS 自动重连，chat 数据重新拉取渲染。
 */
import { escapeHtml, showToast } from "./utils.mjs";
import { mountInlineEdit } from "../../shared/state/utils.mjs"; // [合并批 0714·二] 内联改名输入框 UI 编排收口单源
// [D2 0713] renameChat 直连删除：改名提交统一走 conversationManager.commitChatRename 单源
import { sendAction } from "../../shared/transport/sendAction.mjs"; // T6b批7：出向统一门面（verb=真动作），shells:chat new/delete/getchatlist/char-data/char 收口
import { switchCharacterScope, charList, chatBelongsToChar } from "../../shared/chat-core/chat.mjs";
import { currentChatId, deleteMessage, modifyTimeLine } from "../../shared/transport/endpoints.mjs";
import { getChatLogIndexByQueueIndex, getQueue } from "../../shared/render/virtualQueue.mjs";
import { beiluConfirm } from "../../shared/widgets/beiluDialog.mjs";
import { getCurrentMode, getModeChatIdKey, MODE_CHATID_KEYS } from "../feature/featureControls.mjs"; // [传导链批 0713] getCurrentMode=handleNewChat 单快照入口取值
import { buildModeBadge, buildInUseLabel, buildOtherWindowBadge, showConvModeMenu, loadConvMeta, saveConvMeta, switchToChat, commitChatRename } from "../../shared/chat-core/conversationManager.mjs"; // 凛倾0709:列表用模式徽章单源（无反向依赖,静态安全）；0712:徽章带文字自解释+「XX窗口在用」+🏷️标记单源；0713:getModeInUseMap 已删（服务端单源）；[D5 收口 0713] loadConvMeta/saveConvMeta 元数据读写权威；[R5 0713] switchToChat 切换单源；[D2 0713] commitChatRename 改名提交单源
import { storage, KEYS } from "../../shared/state/storage.mjs";

// [D5 收口 0713] 原三个手抄函数（storage.set 直写 + 自 dispatch）与 conversationManager
//   权威收口并存=同键两套写路径（质量不齐：手抄版无 _selfMetaWrite 守卫）。改薄壳接权威，
//   读写+广播全走单源。[D2 0713] _saveConvMetaEntry 随改名提交收口 commitChatRename 后零消费，纯删。
const _loadConvMeta = loadConvMeta;
function _deleteConvMetaEntry(chatid) {
  try {
    const fresh = loadConvMeta();
    delete fresh[chatid];
    saveConvMeta(fresh);
  } catch { /* ignore */ }
}

// ============================================================
// ≡ 扩展菜单 — 操作处理
// ============================================================

/**
 * 导航到指定聊天（同窗口切换）
 * 切卡免刷：改走 switchCharacterScope 运行时切换（setCurrentChatId + WS 重连 +
 * 重取数据/重渲染 + character-switched 重绑），不再整页 location.reload()。
 * @param {string} chatid - 目标聊天ID
 * @returns {Promise<void>}
 */
async function navigateToChat(chatid, opts = {}) {
  console.debug("[切卡免刷] navigateToChat →", chatid);
  // [传导链批 0713] opts.mode 透传（A1 入口快照范式,对齐 switchToChat）：调用方已定模式线时
  //   显式传入,switchCharacterScope [MO-ISO] 写点不再隔着 await 自取 getCurrentMode。
  await switchCharacterScope(chatid, undefined, { mode: opts.mode });
}

/**
 * 开始新聊天（创建聊天文件并跳转到新聊天）
 */
async function _rollbackNewChat(chatid) {
  try {
    // T6b批7：DELETE /delete → sendAction shells:chat#deleteChat（DELETE + body {chatids}）。
    await sendAction({ verb: "deleteChat", target: "shells:chat", source: "web", payload: { chatids: [chatid] } });
  } catch { /* best-effort */ }
}

async function handleNewChat() {
  try {
    const currentChar = charList && charList.length > 0 ? charList[0] : null;

    // T6b批7：POST /new → sendAction shells:chat#new。!ok 由门面抛错走外层 catch（原 `if(!res.ok) throw` 等价）。
    const data = await sendAction({ verb: "new", target: "shells:chat", source: "web" });

    if (!currentChar) {
      await _rollbackNewChat(data.chatid);
      showToast("当前无角色卡，无法创建对话", "error");
      return;
    }

    let charExists = false;
    try {
      // T6b批7：GET /char-data/:charId → sendAction shells:chat#getCharData。成功=角色存在；!ok 门面抛错走 catch → charExists=false（等价原 checkResp.ok）。
      await sendAction({ verb: "getCharData", target: "shells:chat", source: "web", payload: { charId: currentChar } });
      charExists = true;
    } catch {
      charExists = false;
    }

    if (!charExists) {
      await _rollbackNewChat(data.chatid);
      showToast(`角色卡 "${currentChar}" 已不存在，无法创建对话`, "error");
      return;
    }

    try {
      // T6b批7：POST /:chatId/char 绑定角色 → sendAction shells:chat#bindCharToChat（chatId 进 URL，charname 进 body）。
      await sendAction({ verb: "bindCharToChat", target: "shells:chat", source: "web", scope: { chatId: data.chatid }, payload: { charname: currentChar } });
    } catch (err) {
      await _rollbackNewChat(data.chatid);
      showToast("创建对话失败: " + err.message, "error");
      return;
    }

    showToast("已创建新聊天，正在跳转…", "success");
    // 分类落位收口（0712）：原手抄 _saveConvMetaEntry+modeKey 只写本地——漏服务端 chat_modes，
    // 「在哪个窗口新建就打哪个符号」跨窗口失效。classifyNewChat 单源=本地 mode+服务端+modeKey 三写。
    // 动态 import 防静态环（charsel.mjs:292 同款先例）。
    // [传导链批 0713] 单快照贯穿：原 classifyNewChat 缺省读轴(T1)与 navigateToChat→[MO-ISO]:634
    //   再读轴(T2,隔 resolveChatIdForChar 等 await)是同一动作两次取模式——间隙切 tab=分类落 A 线、
    //   指针落 B 线,一个新对话自我分裂。入口取一次,两个消费点贯穿同值。
    const _newChatMode = getCurrentMode();
    try {
      const { classifyNewChat } = await import("../../shared/chat-core/conversationManager.mjs");
      classifyNewChat(data.chatid, undefined, _newChatMode);
    } catch (e) {
      // [病型全查批2 0713] 原 catch 里 _saveConvMetaEntry+modeKey 直写兜底删除（多源合并判据2:
      //   说不出兜底何时真实发生——conversationManager 是本应用常驻已加载模块,动态 import 失败
      //   =应用已整体不可用;留着=classifyNewChat 单源之外的第二写点,绕服务端双写制造半标记脏指针）。
      //   诚实降级:分类失败可见,不静默造第二源。
      console.warn("[chatmgmt] classifyNewChat 单源不可达,新对话未分类:", e?.message);
    }
    navigateToChat(data.chatid, { mode: _newChatMode });
  } catch (err) {
    showToast("创建新聊天失败: " + err.message, "error");
  }
}

/**
 * 管理聊天文件（弹出聊天列表弹窗）
 */
async function handleManageChats() {
  try {
    // T6b批7：GET /getchatlist → sendAction shells:chat#getChatList。!ok 由门面抛错走 catch（原 `if(!res.ok) throw` 等价）。
    const allChats = await sendAction({ verb: "getChatList", target: "shells:chat", source: "web" });

    // 按当前角色卡过滤聊天列表（只显示当前角色的聊天）
    const currentChar = charList && charList.length > 0 ? charList[0] : null;
    const filteredChats = currentChar
      ? allChats.filter((chat) => chatBelongsToChar(chat, currentChar))
      : allChats;

    showChatManagerModal(filteredChats, currentChar);
  } catch (err) {
    showToast("获取聊天列表失败: " + err.message, "error");
  }
}

/**
 * 批量删除消息（弹出消息选择弹窗）
 */
function handleBatchDelete() {
  const queue = getQueue();
  if (queue.length === 0) {
    showToast("没有可删除的消息", "warning");
    return;
  }
  showBatchDeleteModal(queue);
}

/**
 * 重新生成最后一条 AI 回复
 */
async function handleRegenerate() {
  const queue = getQueue();
  if (queue.length === 0) {
    showToast("没有可重新生成的消息", "warning");
    return;
  }

  const lastMsg = queue[queue.length - 1];
  if (lastMsg.role !== "char") {
    showToast("最后一条消息不是 AI 回复，无法重新生成", "warning");
    return;
  }

  try {
    await modifyTimeLine(1); // 向右切换 = 生成新的时间线分支
    showToast("正在重新生成…", "info");
  } catch (err) {
    showToast("重新生成失败: " + err.message, "error");
  }
}

/**
 * 显示批量删除消息弹窗
 * @param {Array<object>} queue - 消息队列
 */
function showBatchDeleteModal(queue) {
  document.getElementById("batch-delete-overlay")?.remove();

  const overlay = document.createElement("div");
  overlay.id = "batch-delete-overlay";
  overlay.className = "fp-overlay";
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });

  const modal = document.createElement("div");
  modal.className = "fp-modal";
  modal.style.width = "580px";

  // 标题栏
  const header = document.createElement("div");
  header.className = "fp-header";
  header.innerHTML = `
		<span class="fp-title"><i data-ic="trash"></i> 批量删除消息</span>
		<button class="fp-close-btn" title="关闭">×</button>
	`;
  header
    .querySelector(".fp-close-btn")
    .addEventListener("click", () => overlay.remove());

  // 消息列表
  const listContainer = document.createElement("div");
  listContainer.className = "fp-list-container";
  listContainer.style.maxHeight = "450px";

  const selectedIndices = new Set();

  queue.forEach((msg, qIdx) => {
    const chatLogIdx = getChatLogIndexByQueueIndex(qIdx);
    const item = document.createElement("div");
    item.className = "fp-item batch-del-item";
    item.style.cursor = "pointer";

    const roleIcon =
      msg.role === "user" ? '<i data-ic="person"></i>' : msg.role === "char" ? '<i data-ic="bot"></i>' : '<i data-ic="wrench"></i>';
    const name = msg.name || (msg.role === "user" ? "用户" : "AI");
    const preview = (msg.content || "").replace(/\n/g, " ").slice(0, 60);
    const time = msg.time_stamp
      ? new Date(msg.time_stamp).toLocaleTimeString()
      : "";

    item.innerHTML = `
			<label style="display:flex;align-items:center;gap:8px;flex:1;min-width:0;cursor:pointer;">
				<input type="checkbox" class="checkbox checkbox-xs checkbox-warning batch-del-cb"
					data-queue-idx="${qIdx}" data-chatlog-idx="${chatLogIdx}" />
				<span style="font-size:0.75rem;flex-shrink:0;">${roleIcon}</span>
				<span style="font-size:0.75rem;font-weight:500;max-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0;">${escapeHtml(name)}</span>
				<span style="font-size:0.7rem;opacity:0.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;">${escapeHtml(preview)}${preview.length >= 60 ? "…" : ""}</span>
			</label>
			<span style="font-size:0.6rem;opacity:0.3;flex-shrink:0;">${time}</span>
		`;

    const cb = item.querySelector(".batch-del-cb");
    cb.addEventListener("change", () => {
      if (cb.checked) selectedIndices.add(chatLogIdx);
      else selectedIndices.delete(chatLogIdx);
      updateBatchDeleteFooter();
    });

    // 点击行也切换 checkbox（但不影响 label 内的 checkbox 自身事件）
    item.addEventListener("click", (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "LABEL") return;
      cb.checked = !cb.checked;
      cb.dispatchEvent(new Event("change"));
    });

    listContainer.appendChild(item);
  });

  // 底部
  const footer = document.createElement("div");
  footer.className = "fp-footer";
  footer.innerHTML = `
		<div style="display:flex;align-items:center;gap:6px;">
			<button class="dt-btn dt-btn-sm" id="bd-select-all">全选</button>
			<button class="dt-btn dt-btn-sm" id="bd-deselect-all">取消全选</button>
			<span class="fp-selected-label" id="bd-count">已选 0 条</span>
		</div>
		<div class="fp-footer-buttons">
			<button class="fp-confirm-btn" id="bd-confirm" style="background:#dc2626;border-color:#dc2626;" disabled><i data-ic="trash"></i> 删除已选</button>
		</div>
	`;

  const countLabel = footer.querySelector("#bd-count");
  const confirmBtn = footer.querySelector("#bd-confirm");

  function updateBatchDeleteFooter() {
    countLabel.textContent = `已选 ${selectedIndices.size} 条`;
    confirmBtn.disabled = selectedIndices.size === 0;
  }

  // 全选
  footer.querySelector("#bd-select-all").addEventListener("click", () => {
    listContainer.querySelectorAll(".batch-del-cb").forEach((cb) => {
      cb.checked = true;
      selectedIndices.add(parseInt(cb.dataset.chatlogIdx));
    });
    updateBatchDeleteFooter();
  });

  // 取消全选
  footer.querySelector("#bd-deselect-all").addEventListener("click", () => {
    listContainer.querySelectorAll(".batch-del-cb").forEach((cb) => {
      cb.checked = false;
    });
    selectedIndices.clear();
    updateBatchDeleteFooter();
  });

  // 确认删除
  confirmBtn.addEventListener("click", async () => {
    if (selectedIndices.size === 0) return;
    if (
      !await beiluConfirm(
        `确定删除选中的 ${selectedIndices.size} 条消息吗？此操作不可撤销。`,
      )
    )
      return;

    // 从大到小排序索引，避免删除时索引移位
    const sortedIndices = Array.from(selectedIndices).sort((a, b) => b - a);

    confirmBtn.disabled = true;
    confirmBtn.textContent = "⏳ 删除中...";

    let successCount = 0;
    let failCount = 0;

    for (const idx of sortedIndices) {
      try {
        await deleteMessage(idx);
        successCount++;
      } catch (err) {
        console.error(`删除消息 ${idx} 失败:`, err);
        failCount++;
      }
    }

    overlay.remove();

    if (failCount > 0) {
      showToast(`删除完成：${successCount} 成功，${failCount} 失败`, "warning");
    } else {
      showToast(`已删除 ${successCount} 条消息`, "success");
    }
  });

  modal.appendChild(header);
  modal.appendChild(listContainer);
  modal.appendChild(footer);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}

/**
 * 显示聊天管理弹窗
 * @param {Array<object>} chatList - 聊天列表
 */
function showChatManagerModal(chatList, filterCharName) {
  // 移除已存在的弹窗
  document.getElementById("chat-manager-overlay")?.remove();

  const overlay = document.createElement("div");
  overlay.id = "chat-manager-overlay";
  overlay.className = "fp-overlay";
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });

  const modal = document.createElement("div");
  modal.className = "fp-modal";
  modal.style.width = "540px";

  // 标题栏（显示当前角色名，让用户知道是按角色过滤的）
  const titleText = filterCharName
    ? `📂 ${filterCharName} 的聊天`
    : "📂 聊天管理";
  const header = document.createElement("div");
  header.className = "fp-header";
  header.innerHTML = `
		<span class="fp-title">${escapeHtml(titleText)}</span>
		<button class="fp-close-btn" title="关闭">×</button>
	`;
  header
    .querySelector(".fp-close-btn")
    .addEventListener("click", () => overlay.remove());

  // 搜索框（反方审查 0712：全量列表弹窗此前完全无搜索，对话多时找一条只能滚）
  // 按显示名/角色名过滤已渲染行（display 显隐，不重拉后端）。
  const searchRow = document.createElement("div");
  searchRow.style.cssText = "padding:6px 12px;";
  searchRow.innerHTML = '<input type="text" class="input input-xs input-bordered w-full" placeholder="搜索对话名…" />';
  const searchInput = searchRow.querySelector("input");
  searchInput.addEventListener("input", () => {
    const kw = searchInput.value.trim().toLowerCase();
    listContainer.querySelectorAll(".fp-item").forEach((it) => {
      it.style.display = !kw || it.textContent.toLowerCase().includes(kw) ? "" : "none";
    });
  });

  // 聊天列表容器
  const listContainer = document.createElement("div");
  listContainer.className = "fp-list-container";
  listContainer.style.maxHeight = "450px";

  // 对话 meta 读写统一走模块级 _loadConvMeta / _saveConvMetaEntry / _deleteConvMetaEntry（storage wrapper + 广播）

  if (!chatList || chatList.length === 0) {
    listContainer.innerHTML = '<div class="fp-empty">暂无聊天记录</div>';
  } else {
    chatList.forEach((chat) => {
      const item = document.createElement("div");
      item.className = "fp-item";
      item.style.justifyContent = "space-between";

      const isCurrentChat = chat.chatid === currentChatId;
      // 对话名优先级（N39 单源对齐 conversationManager:293）：服务端 customName > localStorage 兜底 > 首条消息 > 角色名 > ID截取
      const _cMeta = _loadConvMeta()[chat.chatid] || {};
      const customLabel = chat.customName || _cMeta.label || "";
      // 0713 补丁删除：模式徽标唯一权威=服务端 chat.mode（getChatList 恒注入，空串=未分类不显示）。
      // 原 `chat.mode || _cMeta.mode` 本地回退=多源合并（补丁形式识别 P3），删。
      const _cBadge = buildModeBadge(chat.mode);
      // 「XX窗口在用」标签：服务端 usedByModes 单源 +「另一浏览器窗口在用」补充角标（D4 收口单源）
      const _usingLabel = buildInUseLabel(chat.usedByModes);
      const _inUseBadge = buildOtherWindowBadge(chat.chatid, chat.inUseCount);
      const displayName =
        customLabel ||
        chat.firstUserMessage ||
        (chat.chars || []).join(", ") ||
        chat.chatid?.substring(0, 8) + "...";
      const lastTime = chat.lastMessageTime
        ? new Date(chat.lastMessageTime).toLocaleString()
        : "";
      const lastContent = (chat.lastMessageContent || "").slice(0, 40);
      const sender = chat.lastMessageSender || "";

      item.innerHTML = `
  		<div style="flex:1;min-width:0;">
  			<div style="display:flex;align-items:center;gap:6px;">
  				${_cBadge}${_usingLabel}${_inUseBadge}
  				<span class="fp-item-name chat-display-name" style="font-weight:${isCurrentChat ? "700" : "400"};color:${isCurrentChat ? "var(--beilu-amber)" : "inherit"};">
  					${escapeHtml(displayName)}${isCurrentChat ? " (当前)" : ""}
  				</span>
  			</div>
  			<div style="font-size:0.7rem;opacity:0.5;padding-left:1.5rem;margin-top:2px;">
  				${escapeHtml(sender)}: ${escapeHtml(lastContent)}${lastContent.length >= 40 ? "…" : ""}
  			</div>
  		</div>
  		<div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
  			<span style="font-size:0.65rem;opacity:0.4;">${lastTime}</span>
  			<button class="chat-open-btn dt-btn dt-btn-sm" title="打开" style="font-size:0.7rem;">打开</button>
  			<button class="chat-rename-btn dt-btn dt-btn-sm" title="重命名" style="font-size:0.7rem;"><i data-ic="edit"></i></button>
  			<button class="chat-mark-btn dt-btn dt-btn-sm" title="标记模式图标" style="font-size:0.7rem;">🏷️</button>
  			<button class="chat-delete-btn dt-btn dt-btn-sm dt-btn-danger" title="删除" style="font-size:0.7rem;"${isCurrentChat ? " disabled" : ""}><i data-ic="trash"></i></button>
  		</div>
  	`;

      // 打开聊天（同窗口跳转）
      item.querySelector(".chat-open-btn").addEventListener("click", (e) => {
        e.stopPropagation();
        if (isCurrentChat) {
          showToast("已经在当前聊天", "info");
          overlay.remove();
          return;
        }
        overlay.remove();
        // [R2/R5 0713] 原 _saveConvMetaEntry+getModeChatIdKey 直写（绕 markModeActiveChat 收口，
        //   只写本地不写服务端=双源漂移产地；现取 getCurrentMode() 无入口快照，tab 联动飞行期错键）
        //   删除，改走 switchToChat 单源（lastActive+模式快照+[MO-ISO] 指针双写全继承）。
        switchToChat(chat.chatid);
      });

      // 🏷️标记模式（四渲染点操作一致性收口 0712）
      item.querySelector(".chat-mark-btn")?.addEventListener("click", (e) => {
        e.stopPropagation();
        showConvModeMenu(e, chat.chatid);
      });

      // 重命名聊天（仅前端显示名）— 使用内联输入框替代 prompt()
      item.querySelector(".chat-rename-btn").addEventListener("click", (e) => {
        e.stopPropagation();
        const nameEl = item.querySelector(".chat-display-name");
        if (!nameEl) return;

        // [合并批 0714·二] UI 编排收口 mountInlineEdit 单源（4 处同构副本）；
        // 数据提交仍走 commitChatRename（D2 0713），本处只管弹窗行的显示名回写
        mountInlineEdit(nameEl, {
          value: _loadConvMeta()[chat.chatid]?.label || "",
          placeholder: "输入对话名称…",
          cssText:
            "width:100%;font-size:0.8rem;padding:2px 4px;border:1px solid var(--beilu-amber,#f59e0b);border-radius:4px;background:var(--color-base-100,#1d232a);color:inherit;outline:none;",
          onCommit: async (newName) => {
            await commitChatRename(chat.chatid, newName);
            // 计算新的显示名（空名=恢复默认，N39：服务端回落首条消息，本地不显示旧 customName）
            const updatedName =
              newName ||
              chat.firstUserMessage ||
              (chat.chars || []).join(", ") ||
              chat.chatid?.substring(0, 8) + "...";
            nameEl.textContent = updatedName + (isCurrentChat ? " (当前)" : "");
          },
        });
      });
      // 删除聊天
      // 删除聊天
      const deleteBtn = item.querySelector(".chat-delete-btn");
      deleteBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (isCurrentChat) return;
        if (!await beiluConfirm(`确定删除聊天 "${displayName}" 吗？（删除后进回收站，可找回）`)) // 缺陷5：对齐后端 safeUnlink 回收站行为
          return;

        try {
          // T6b批7：DELETE /delete → sendAction shells:chat#deleteChat。!ok 由门面抛错走 catch（原 `if(!res.ok) throw` 等价）。
          await sendAction({ verb: "deleteChat", target: "shells:chat", source: "web", payload: { chatids: [chat.chatid] } });

          _deleteConvMetaEntry(chat.chatid);
          const _charName = storage.get(KEYS.BEILU_LAST_CHAR) || "";
          // 数据驱动收口（六域纠察缺陷4a）：原硬编码三值漏 smart（0706 smart 升独立线后，删 smart 绑定对话
          //   此处不清 beilu-smart-chatid:{char} key=悬空绑定）。对齐 conversationManager 删除链同款写法。
          for (const [_m] of Object.entries(MODE_CHATID_KEYS)) {
            const _mk = getModeChatIdKey(_m, _charName);
            if (_mk && storage.get(_mk) === chat.chatid) storage.remove(_mk);
          }
          item.remove();
          const remaining = listContainer.querySelectorAll(".fp-item").length;
          const countLabel = footer.querySelector(".fp-selected-label");
          if (countLabel) countLabel.textContent = `${remaining} 个聊天`;
          if (remaining === 0) {
            listContainer.innerHTML =
              '<div class="fp-empty">暂无聊天记录</div>';
          }
          showToast("聊天已删除", "success");
        } catch (err) {
          showToast("删除失败: " + err.message, "error");
        }
      });
      item.addEventListener("dblclick", () => {
        if (isCurrentChat) return;
        overlay.remove();
        // [R2/R5 0713] 同上方单击打开：直写删除，切换收口 switchToChat 单源。
        switchToChat(chat.chatid);
      });

      listContainer.appendChild(item);
    });
  }

  // 底部
  const footer = document.createElement("div");
  footer.className = "fp-footer";
  footer.innerHTML = `
		<span class="fp-selected-label">${chatList.length} 个聊天</span>
		<div class="fp-footer-buttons">
			<button class="fp-confirm-btn" id="cm-new-chat-btn"><i data-ic="message"></i> 新建聊天</button>
		</div>
	`;
  footer
    .querySelector("#cm-new-chat-btn")
    .addEventListener("click", async () => {
      overlay.remove();
      await handleNewChat(); // handleNewChat 内部会创建并跳转
    });

  modal.appendChild(header);
  modal.appendChild(listContainer);
  modal.appendChild(footer);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}

export { handleNewChat, handleManageChats, handleBatchDelete, handleRegenerate };

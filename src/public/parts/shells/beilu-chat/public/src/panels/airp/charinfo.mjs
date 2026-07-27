/**
 * @file charinfo.mjs — 角色快捷信息面板（左栏）cluster
 *
 * 【用户视角功能】
 *   左栏显示当前角色的头像/名字/描述/开场白。切角色后立即刷新。编辑按钮指向当前角色。
 *
 * 【功能链 — 用户操作 → 传导 → 效果】
 *   页面加载 → initCharInfoPanel → loadCharInfo(charId) → 填充头像/名字/描述/开场白
 *   用户切角色 → switchCharacterScope dispatch beilu:char-changed
 *     → 本模块监听 → loadCharInfo(newCharId, {_skipCharChangedEvent:true}) → 面板刷新
 *     → _skipCharChangedEvent 避免 loadCharInfo 再次 dispatch beilu:char-changed（防 double-fire）
 *   用户点编辑 → getCharId() 读 sharedState → 打开对应角色编辑 iframe
 *   其他客户端编辑角色卡 → WS beilu:char-data-changed → loadCharInfo(changed) → 面板同步
 *   绑卡失败 → _renderCharLoadFailure 渲染警告态 + 重试/检查按钮
 *
 * 【why — 为什么 loadCharInfo 自身也 dispatch beilu:char-changed】
 *   init 路径（页面加载）时，featureControls 等模块需要知道角色卡已加载完成才能执行
 *   syncModeFromBackend，所以 loadCharInfo 在 init 路径 dispatch beilu:char-changed。
 *   切角色路径时，switchCharacterScope 已经 dispatch 过，loadCharInfo 用
 *   _skipCharChangedEvent=true 跳过，避免消费者被重复触发。
 *
 * 【关联链】
 *   上游：index.mjs init()、switchCharacterScope beilu:char-changed
 *   下游：sharedState.setCharId（编辑按钮读取）、beilu:char-changed（featureControls 等消费）
 *   连锁：charNameDisplay.dataset.charId → scriptManager 轮询变化检测
 *
 * 【影响范围】
 *   左栏角色信息面板、编辑按钮指向、sharedState.charId、
 *   beilu:char-changed 所有消费者、scriptManager 轮询检测
 */
import { showToast, escapeHtml, getCurrentCharId, waitForCharIdReady } from "./utils.mjs";
import { resolveAvatar } from "../../shared/state/utils.mjs"; // 0719 头像读侧四处统一契约（charsel 同款）
import { setCharId, getCharId } from "../../shared/state/sharedState.mjs";
import { getInitialData } from "../../shared/transport/endpoints.mjs";
import { getQueue } from "../../shared/render/virtualQueue.mjs";
import { getPartDetails } from "../../../../../../scripts/parts.mjs";
import { sendAction } from "../../shared/transport/sendAction.mjs"; // T6b批7：出向统一门面（verb=真动作），chars 缓存 + char-data + update-char 收口

// ============================================================
// 角色快捷信息面板（左栏）
// ============================================================

// 开场白延迟加载的代号（每次 loadCharInfo 自增，3s 定时器 fire 时对不上=已切卡，作废）
let _greetingLoadGen = 0;

const charAvatarDisplay = document.getElementById("char-avatar-display");
const charNameDisplay = document.getElementById("char-name-display");
const charDescShort = document.getElementById("char-desc-short");
const charGreetingEdit = document.getElementById("char-greeting-edit");
const charDescriptionEdit = document.getElementById("char-description-edit");
const charInfoEditBtn = document.getElementById("char-info-edit-btn");
const charInfoSaveBtn = document.getElementById("char-info-save-btn");
const charInfoCancelBtn = document.getElementById("char-info-cancel-btn");

/** 原始数据备份（用于取消编辑时还原） */
let _charInfoOriginal = {};
/** 去重：上一次 loadCharInfo 加载的 charId，防止 beilu:char-changed 循环触发 */
let _loadedCharId = null;

/**
 * 初始化角色信息面板
 * 从 charList[0] 获取主角色信息并填充 UI
 */
// #5 绑卡失败可见性:把 getInitialData 的 charLoadFailures{charname:原因} 渲染成失败态——
//   复用角色信息面板(头像→⚠️、名字→「卡名」加载失败、描述→原因),加 [↻重试加载]/[✏️检查角色卡]。
//   不再空 charId 干等 30s。失败态在成功 loadCharInfo 时由 _clearCharLoadFailure 清掉。
function _renderCharLoadFailure(failures) {
  const names = Object.keys(failures || {});
  if (!names.length) return false;
  const name = names[0];
  const reason = String(failures[name] || "未知原因");
  const avatar = document.getElementById("char-avatar-display");
  const nameEl = document.getElementById("char-name-display");
  const descEl = document.getElementById("char-description-edit");
  if (avatar) { avatar.innerHTML = '<i data-ic="warning"></i>'; avatar.classList.add("bg-warning/15"); }
  if (nameEl) { nameEl.textContent = `「${name}」加载失败`; nameEl.style.color = ""; nameEl.classList.add("text-warning"); nameEl.title = name; }
  if (descEl) { descEl.value = `已绑定，但角色卡无法载入：\n${reason}`; }
  if (descEl && !document.getElementById("char-load-fail-box")) {
    const box = document.createElement("div");
    box.id = "char-load-fail-box";
    box.className = "mt-1 flex justify-end gap-1";
    box.innerHTML = `<button id="char-fail-retry" class="btn btn-xs btn-warning btn-outline" type="button"><i data-ic="refresh"></i> 重试加载</button><button id="char-fail-check" class="btn btn-xs btn-outline" type="button" title="打开角色卡列表排查"><i data-ic="edit"></i> 检查角色卡</button>`;
    descEl.parentElement?.appendChild(box);
    box.querySelector("#char-fail-retry")?.addEventListener("click", () => { box.querySelector("#char-fail-retry").innerHTML = '<i data-ic="refresh"></i> 重新拉取…'; initCharInfoPanel(); });
    box.querySelector("#char-fail-check")?.addEventListener("click", () => { document.getElementById("header-char-name")?.click(); });
  }
  return true;
}
// 成功载入 / 离开失败态时清理(头像名字 class 复位 + 移除失败操作区)。
function _clearCharLoadFailure() {
  const avatar = document.getElementById("char-avatar-display");
  const nameEl = document.getElementById("char-name-display");
  if (avatar) avatar.classList.remove("bg-warning/15");
  if (nameEl) { nameEl.classList.remove("text-warning"); nameEl.style.color = "var(--beilu-amber)"; }
  document.getElementById("char-load-fail-box")?.remove();
}

async function initCharInfoPanel() {
  const charId = getCurrentCharId();
  console.log("[beilu-chat][DIAG] initCharInfoPanel 开始, charId:", charId);
  if (!charId) {
    // #5: 空 charId 时先看 initial-data 的 charLoadFailures——charlist 空 + 有失败记录 =
    //   绑定的卡加载失败(非"还没加载")→ 立即点名失败态,不干等 30s。
    try {
      const init = await getInitialData();
      const failures = init?.charLoadFailures || {};
      if (!(init?.charlist?.length) && Object.keys(failures).length) {
        _renderCharLoadFailure(failures);
        console.warn("[beilu-chat] 角色卡加载失败,已渲染失败态:", Object.keys(failures).join(", "));
        return;
      }
    } catch (e) { /* 取不到 initial-data 就走原重试逻辑 */ }
    // charList 可能还没加载，用共享 polling 延迟重试
    console.log("[beilu-chat][DIAG] charId 为空，启动延迟重试");
    waitForCharIdReady(id => {
      console.log("[beilu-chat][DIAG] initCharInfoPanel 延迟获取到 charId:", id);
      loadCharInfo(id);
    });
    // W54修复P7: 超时后尝试从API获取角色名显示到header
    // waitForCharIdReady 30s超时后静默放弃(不调callback)——此时仍需尝试显示角色名
    setTimeout(async () => {
      if (getCurrentCharId()) return; // 已成功，不需要fallback
      const headerText = document.getElementById("header-char-name-text");
      if (headerText && !headerText.textContent) {
        try {
          // T6b批7：GET /getallcacheddetails/chars → sendAction server:chars#listAllCached。!ok 由门面抛错走 catch（原 res.ok 为假时静默跳过，等价）。
          const data = await sendAction({ verb: "listAllCached", target: "server:chars", source: "web" });
          const names = Object.keys(data?.cachedDetails || {});
          if (names.length > 0) {
            headerText.textContent = names[0];
            console.log("[beilu-chat] P7 fallback: 设置角色名为", names[0]);
          }
        } catch {}
      }
      console.warn(
        "[beilu-chat][DIAG] initCharInfoPanel 延迟重试超时(30s)，charId 仍为空",
      );
    }, 30000);
    return;
  }
  await loadCharInfo(charId);
}

/**
 * 加载指定角色卡的信息到面板 UI
 * @param {string} charId - 角色卡 ID（目录名）
 */
async function loadCharInfo(charId, { _skipCharChangedEvent = false } = {}) {
  _loadedCharId = charId;
  console.log("[beilu-chat][DIAG] loadCharInfo 开始, charId:", charId);
  _clearCharLoadFailure(); // #5: 成功载入某卡 → 清掉之前的加载失败态(头像/名字 class 复位 + 移除失败操作区)
  try {
    const details = await getPartDetails("chars/" + charId);
    // [0717 async-order guard, audit H1] rapid char switching: a slow response for a
    // previous char must not overwrite the newer char's panel. _loadedCharId is set at
    // entry by every call (last-caller-wins anchor); stale responses bail out here.
    if (_loadedCharId !== charId) return;
    if (!details?.info) {
      if (charNameDisplay) {
        charNameDisplay.textContent = charId || "未加载角色";
        setCharId(charId || "");
      }
      if (charDescShort) charDescShort.textContent = "角色信息暂不可用";
      if (charDescriptionEdit) {
        charDescriptionEdit.value = "暂无角色描述（角色信息未就绪）";
        charDescriptionEdit.placeholder = "暂无角色描述";
      }
      if (charGreetingEdit) {
        charGreetingEdit.value = "(开场白加载失败)";
      }
      return;
    }

    const info = details.info;

    // 头像（0719 对齐 resolveAvatar 统一契约：本处是四读侧里唯一裸读 info.avatar 的——
    //   相对文件名/未替换宏直接进 src 必坏图，charsel/panels/sidebar 三处已走 resolveAvatar 单源）
    if (charAvatarDisplay) {
      const _avatarUrl = resolveAvatar({ avatar: info.avatar, kind: "chars", name: charId, fallback: "" });
      if (_avatarUrl) {
        charAvatarDisplay.innerHTML = `<img src="${escapeHtml(_avatarUrl)}" class="w-full h-full object-cover" alt="avatar" onerror="this.parentElement.textContent='🎭'" />`;
      } else {
        charAvatarDisplay.innerHTML = '<i data-ic="drama"></i>';
      }
    }

    // 名字
    if (charNameDisplay) {
      charNameDisplay.textContent = info.name || charId;
      charNameDisplay.dataset.charId = charId; // P4c：成功分支补写（原仅失败分支写，此键对下游读者恒空/恒旧）
      setCharId(charId);
    }
    const headerCharNameText = document.getElementById("header-char-name-text");
    if (headerCharNameText) headerCharNameText.textContent = info.name || charId;

    // Phase2 修复：通知所有模块角色卡已加载（激活 featureControls 中的 beilu:char-changed 监听器）
    // 切角色路径：switchCharacterScope 已 dispatch 过 beilu:char-changed，本函数由监听器调用时
    // _skipCharChangedEvent=true 避免 double-fire（featureControls 等消费者收到重复事件）
    if (!_skipCharChangedEvent) {
      console.log(
        "[beilu-chat] loadCharInfo: dispatch beilu:char-changed, charId:",
        charId,
      );
      window.dispatchEvent(
        new CustomEvent("beilu:char-changed", {
          detail: { charId, charName: info.name || charId, _fromInit: true },
        }),
      );
      window.emitBeiluEvent?.("character_changed", { charName: info.name || charId });
    }

    // 短描述
    if (charDescShort) charDescShort.textContent = info.description || "";

    // 角色描述：优先用 getPartDetails 的 description_markdown/description
    // 如果为空，fallback 到 char-data API 中的 description/personality/system_prompt
    let descValue = info.description_markdown || info.description || "";

    if (!descValue) {
      try {
        // T6b批7：GET /char-data/:charId → sendAction shells:chat#getCharData。!ok 由门面抛错走本 try 的 catch（原 charDataResp.ok 为假时 descValue 保持 ""，等价）。
        const charData = await sendAction({ verb: "getCharData", target: "shells:chat", source: "web", payload: { charId } });
        if (_loadedCharId !== charId) return; // [0717 async-order guard, audit H1] second await, same bail-out
        // SillyTavern V2 格式：charData.data.description，V1：charData.description
        const cdDesc =
          charData?.data?.description || charData?.description || "";
        const cdPersonality =
          charData?.data?.personality || charData?.personality || "";
        const cdSysPrompt =
          charData?.data?.system_prompt || charData?.system_prompt || "";
        // 按优先级 fallback
        descValue = cdDesc || cdPersonality || cdSysPrompt || "";
      } catch (e) {
        console.warn(
          "[beilu-chat] loadCharInfo char-data fallback 失败:",
          e.message,
        );
      }
    }

    if (charDescriptionEdit) {
      charDescriptionEdit.value = descValue;
      charDescriptionEdit.placeholder = descValue ? "角色描述" : "暂无角色描述";
    }

    // 开场白 — 延迟从聊天队列获取第一条角色消息。
    // 代号防跨卡竞态：3s 内切换角色时旧定时器作废，否则旧 timer 会覆写新卡的开场白框。
    if (charGreetingEdit) {
      charGreetingEdit.value = "(加载中...)";
      const gen = ++_greetingLoadGen;
      setTimeout(() => {
        if (gen !== _greetingLoadGen) return;
        try {
          const queue = getQueue();
          const firstCharMsg = queue.find((m) => m.role === "char");
          charGreetingEdit.value =
            firstCharMsg?.content || "(开场白由角色代码定义)";
        } catch {
          charGreetingEdit.value = "(开场白由角色代码定义)";
        }
      }, 3000);
    }

    _charInfoOriginal = {
      description_markdown: descValue,
    };
  } catch (err) {
    console.error(
      "[beilu-chat][DIAG] loadCharInfo 失败:",
      err.message,
      err.stack,
    );
    if (charNameDisplay) {
      charNameDisplay.textContent = charId || "未加载角色";
      charNameDisplay.dataset.charId = charId || "";
    }
    if (charDescShort) charDescShort.textContent = "角色信息加载失败";
    if (charDescriptionEdit) {
      charDescriptionEdit.value = "角色描述加载失败，请稍后重试。";
      charDescriptionEdit.placeholder = "暂无角色描述";
    }
    if (charGreetingEdit) {
      charGreetingEdit.value = "(开场白加载失败)";
    }
  }
}

// 编辑按钮 — 打开 beilu-chat 内的编辑器 tab
charInfoEditBtn?.addEventListener("click", () => {
  window.dispatchEvent(new CustomEvent("beilu:openEditorTab", { detail: "preset-edit" }));
});

// 取消按钮
charInfoCancelBtn?.addEventListener("click", () => {
  if (charGreetingEdit) {
    charGreetingEdit.readOnly = true;
    charGreetingEdit.classList.remove("textarea-warning");
  }
  if (charDescriptionEdit) {
    charDescriptionEdit.readOnly = true;
    charDescriptionEdit.classList.remove("textarea-warning");
    charDescriptionEdit.value = _charInfoOriginal.description_markdown;
  }
  charInfoEditBtn?.classList.remove("hidden");
  charInfoSaveBtn?.classList.add("hidden");
  charInfoCancelBtn?.classList.add("hidden");
});

// 切角色时刷新面板：switchCharacterScope dispatch beilu:char-changed → 重新加载新角色信息
window.addEventListener("beilu:char-changed", (e) => {
  const charId = e.detail?.charId;
  if (charId && charId !== _loadedCharId) {
    loadCharInfo(charId, { _skipCharChangedEvent: true }).catch(() => {});
  }
});

// 跨客户端角色卡内容同步：另一端(本体↔YonBan)编辑了某角色卡 → 若本端正在看该卡，重载信息面板。
window.addEventListener("beilu:char-data-changed", (e) => {
  const changed = e?.detail?.charName;
  if (changed && changed === getCurrentCharId()) {
    loadCharInfo(changed).catch(() => { /* 重载失败不致命 */ });
  }
});

// 保存按钮 — 保存开场白和角色描述到角色卡
charInfoSaveBtn?.addEventListener("click", async () => {
  const charId = getCurrentCharId();
  if (!charId) {
    showToast("没有加载角色卡", "error");
    return;
  }

  try {
    // 读取当前编辑的值
    const newDescription = charDescriptionEdit?.value || "";
    const newGreeting = charGreetingEdit?.value || "";

    // 通过 beilu-chat 的 update-char API 更新角色卡 chardata.json
    // T6b批7：PUT /update-char/:charId（JSON {description}）→ sendAction shells:chat#updateChar（charId 进 URL，description 进 body）。
    //   !ok 由门面统一抛错走 catch（原 !saveResp.ok 的错误展示等价并入）。
    await sendAction({
      verb: "updateChar",
      target: "shells:chat",
      source: "web",
      payload: { charId, description: newDescription },
    });

    // 更新本地缓存
    _charInfoOriginal.description_markdown = newDescription;

    // 退出编辑模式
    charInfoCancelBtn?.click();
    showToast("角色信息已保存", "success");
  } catch (err) {
    showToast("保存失败: " + err.message, "error");
  }
});

export { initCharInfoPanel };

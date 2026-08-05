/**
 * @file persona.mjs — 用户人设选择（左栏）cluster
 *
 * 【用户视角功能】
 *   左栏人设下拉框：用户选择"我是谁"，影响AI视角中的用户身份。
 *   切角色后自动同步新对话绑定的人设。从编辑弹窗/sidebar激活人设后左栏立即同步。
 *
 * 【功能链 — 用户操作 → 传导 → 效果】
 *   页面加载 → initPersonaSelector → 拉列表填充下拉 → syncValue 同步当前值
 *   用户在左栏选人设 → setPersona(后端) + setPersonaName(全局) + 更新UI（本地+远端同步）
 *   用户切角色 → switchCharacterScope updateSidebar → setPersonaName(新值)
 *     → dispatch beilu:char-changed → 本模块监听 → _syncPersonaUI 重新读personaName更新下拉
 *   编辑弹窗激活/sidebar切换 → WS persona_set → handlePersonaSet → 补偿同步
 *
 * 【why — 为什么需要监听 beilu:char-changed】
 *   切角色时新chatid可能绑定不同的人设。switchCharacterScope步骤9 updateSidebar
 *   已经通过 setPersonaName(data.personaname) 更新了全局变量，但左栏下拉框没有
 *   重新读取这个变量。需要在beilu:char-changed时重新同步UI。
 *
 * 【关联链】
 *   上游：index.mjs init()、beilu:char-changed（切角色同步）
 *   下游：chat.mjs personaName/setPersonaName、endpoints.mjs setPersona
 *   交叉：panels.mjs persona激活按钮、sidebar.mjs personaSelect + handlePersonaSet
 *
 * 【影响范围】
 *   左栏人设下拉框 + 状态文本 + 描述区；
 *   AI生成时的用户身份（personaName传入prompt构造）
 */
import { showToast } from "./utils.mjs";
import { whenVisible } from "../../shared/state/utils.mjs"; // 0718 可见性门控
import { personaName, setPersonaName } from "../../shared/chat-core/chat.mjs";
import { setPersona } from "../../shared/transport/endpoints.mjs";
import { getPartDetails, getPartList } from "../../../../../../scripts/parts.mjs";
import { sendAction } from "../../shared/transport/sendAction.mjs"; // T6b批7：出向统一门面（verb=真动作），beilu-memory getdata + persona 描述保存收口

// ============================================================
// 用户人设选择（左栏）
// ============================================================

const leftPersonaSelect = document.getElementById("left-persona-select");
const leftPersonaStatus = document.getElementById("left-persona-status");
const leftPersonaDesc = document.getElementById("left-persona-desc");
const personaEditBtn = document.getElementById("persona-edit-btn");
const personaSaveBtn = document.getElementById("persona-save-btn");
const personaCancelBtn = document.getElementById("persona-cancel-btn");

/** 用户人设描述原始值备份（取消编辑时还原） */
let _personaDescOriginal = "";

/**
 * 初始化用户人设选择下拉框
 * 从 beilu parts API 获取 persona 列表，填充下拉框，绑定事件
 * 支持编辑/保存/取消人设描述
 */
async function initPersonaSelector() {
  if (!leftPersonaSelect) return;

  try {
    const personas = await getPartList("personas");

    // B34修复: 默认persona显示账户名
    let defaultLabel = "(默认)";
    try {
      // T6b批7：getdata → sendAction beilu-memory#getData（桥路由，unwrap 还原裸数据）。原 .then(r=>r.json()) 收口进门面。
      const memData = await sendAction({ verb: "getData", target: "plugins:beilu-memory", source: "web" });
      if (memData?.username) defaultLabel = memData.username + " (默认)";
    } catch {}
    // 填充下拉框
    leftPersonaSelect.innerHTML = `<option value="">${defaultLabel}</option>`;
    personas.forEach((name) => {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      leftPersonaSelect.appendChild(opt);
    });

    // 空人设时直接告诉用户唯一的新建入口；按钮做成整行，避免与折叠箭头挤在同一视觉角落。
    if (leftPersonaDesc) {
      leftPersonaDesc.placeholder = personas.length > 0
        ? "选择人设后显示描述..."
        : "暂无自定义人设；请前往「预设编辑 → 用户」新建。";
    }
    if (personaEditBtn) {
      personaEditBtn.classList.add("w-full");
      personaEditBtn.title = "前往「预设编辑 → 用户」管理或新建人设";
      personaEditBtn.textContent = "管理 / 新建人设";
    }

    // 设置当前值
    // 设置当前值，并主动向后端 apply 一次，确保人设真正生效
    const syncValue = async () => {
      leftPersonaSelect.value = personaName || "";
      if (leftPersonaStatus) leftPersonaStatus.textContent = personaName || "默认";
      // 加载描述
      if (personaName && leftPersonaDesc) {
        try {
          const details = await getPartDetails("personas/" + personaName);
          const desc = details?.info?.description || "";
          leftPersonaDesc.value = desc;
          _personaDescOriginal = desc;
        } catch {
          leftPersonaDesc.value = "";
          _personaDescOriginal = "";
        }
      } else if (leftPersonaDesc) {
        leftPersonaDesc.value = "";
        _personaDescOriginal = "";
      }
      // ★ 修复：主动向后端 apply 人设，确保聊天已绑定正确的人设
      // 仅在 personaName 非空时执行，避免不必要地清除人设
      if (personaName) {
        try {
          await setPersona(personaName);
          console.log("[beilu-chat] 人设初始化 apply:", personaName);
        } catch (e) {
          console.warn(
            "[beilu-chat] 人设初始化 apply 失败（非致命）:",
            e.message,
          );
        }
      }
      // 确保退出编辑模式
      exitPersonaEditMode();
    };
    await syncValue();

    // 延迟重试：等待 personaName 从 initializeChat/updateSidebar 中被赋值
    if (!personaName) {
      let retryCount = 0;
      const MAX_RETRIES = 8; // 最多等 16 秒（8次 × 2秒）
      const retryTimer = setInterval(async () => {
        retryCount++;
        if (personaName != null || retryCount >= MAX_RETRIES) {
          clearInterval(retryTimer);
          if (personaName != null) {
            await syncValue();
          }
        }
      }, 2000);
    }
    // 选择变化时设置人设
    leftPersonaSelect.addEventListener("change", async () => {
      const newName = leftPersonaSelect.value || null;
      try {
        await setPersona(newName);
        setPersonaName(newName);
        if (leftPersonaStatus) leftPersonaStatus.textContent = newName || "默认";
        // 更新描述
        if (newName && leftPersonaDesc) {
          try {
            const details = await getPartDetails("personas/" + newName);
            const desc = details?.info?.description || "";
            leftPersonaDesc.value = desc;
            _personaDescOriginal = desc;
          } catch {
            leftPersonaDesc.value = "";
            _personaDescOriginal = "";
          }
        } else if (leftPersonaDesc) {
          leftPersonaDesc.value = "";
          _personaDescOriginal = "";
        }
        // 切换人设时退出编辑模式
        exitPersonaEditMode();
        showToast(
          `人设已${newName ? "设为: " + newName : "恢复默认"}`,
          "success",
        );
      } catch (err) {
        showToast("设置人设失败: " + err.message, "error");
        leftPersonaSelect.value = personaName || "";
      }
    });

    // 编辑按钮 (AIRP-T11: 跳转编辑弹窗 persona-edit Tab)
    personaEditBtn?.addEventListener("click", () => {
      window.dispatchEvent(new CustomEvent("beilu:openEditorTab", { detail: "persona-edit" }));
    });

    // 取消按钮
    personaCancelBtn?.addEventListener("click", () => {
      if (leftPersonaDesc) {
        leftPersonaDesc.value = _personaDescOriginal;
      }
      exitPersonaEditMode();
    });

    // 保存按钮
    personaSaveBtn?.addEventListener("click", async () => {
      if (!personaName) {
        showToast("没有选中的人设", "error");
        return;
      }
      const newDesc = leftPersonaDesc?.value || "";
      try {
        const formData = new FormData();
        formData.append("description", newDesc);
        // T6b批7：PUT /persona/:name/update（FormData）→ sendAction shells:chat#updatePersona
        //   （personaName 进 URL，formData 原样透传由 apiFetch 识别 FormData 不 JSON 化）。
        //   !ok 由门面统一抛错走 catch（原 !saveResp.ok 分支的错误展示等价并入）。
        await sendAction({
          verb: "updatePersona",
          target: "shells:chat",
          source: "web",
          payload: { personaName, formData },
        });
        _personaDescOriginal = newDesc;
        exitPersonaEditMode();
        showToast("人设描述已保存", "success");
      } catch (err) {
        showToast("保存失败: " + err.message, "error");
      }
    });
  } catch (err) {
    console.warn("[beilu-chat] initPersonaSelector 失败:", err);
  }
}

/**
 * 退出人设描述编辑模式
 */
function exitPersonaEditMode() {
  if (leftPersonaDesc) {
    leftPersonaDesc.readOnly = true;
    leftPersonaDesc.classList.remove("textarea-warning");
  }
  personaEditBtn?.classList.remove("hidden");
  personaSaveBtn?.classList.add("hidden");
  personaCancelBtn?.classList.add("hidden");
}

// 切角色时同步人设下拉：switchCharacterScope updateSidebar 已设 personaName，这里重新读取更新UI
// 不发 setPersona 后端请求——后端新chatid的metadata已有正确的人设
window.addEventListener("beilu:char-changed", () => {
  if (!leftPersonaSelect) return;
  leftPersonaSelect.value = personaName || "";
  if (leftPersonaStatus) leftPersonaStatus.textContent = personaName || "默认";
  if (personaName && leftPersonaDesc) {
    // [0716 竞态修] 捕获本次请求目标，响应后与 live 绑定 personaName 比对（ESM live binding，
    //   切角色时 chat.mjs 已更新）——快速连切角色时旧人设的慢响应后至会覆盖新人设描述框。
    const _reqPersona = personaName;
    getPartDetails("personas/" + _reqPersona).then(details => {
      if (_reqPersona !== personaName) return; // 期间又切了角色，丢弃旧响应
      const desc = details?.info?.description || "";
      leftPersonaDesc.value = desc;
      _personaDescOriginal = desc;
    }).catch(() => {
      if (_reqPersona !== personaName) return;
      if (leftPersonaDesc) leftPersonaDesc.value = "";
      _personaDescOriginal = "";
    });
  } else if (leftPersonaDesc) {
    leftPersonaDesc.value = "";
    _personaDescOriginal = "";
  }
  exitPersonaEditMode();
});

export { initPersonaSelector };

/**
 * flowGroupModelDialog.mjs — Skill组（流程组）级 API 源/模型更改弹窗流程（共享，两入口复用）
 *
 * 功能链（凛倾 2026-07-15「不需要AI决定api…ai新建之后需要进行通知,弹出是否更改模型或者api」）：
 *   AI <createFlowGroup> 建组 → 后端复制当时活跃子模式的源/模型进组级 api_source/model_params
 *   → 前端两入口调本流程更改：
 *     ① websocket _maybeHandleFlowGroupCreated（建组通知弹窗「保持/更改」→ 更改走本函数）
 *     ② subModePanel 组详情面板「源/模型」行（操作闭环：错过通知弹窗后仍可改）
 *   → 选源（getCachedApiSources，含「跟随全局」空项）→ 选模型（getCachedModelList，拉不到退手输）
 *   → sendAction updateFlowGroup 浅 merge 写回组 json → 生成时 getPromptHandler flowGroupModelSnap 消费。
 *
 * why：
 *   组级源/模型是「执行该组期间的绑定」，与子模式绑定同层语义；更改=整组原子替换 model_params
 *   （N36：源+模型是原子覆盖单元——换源后旧源语境的模型/采样快照不再成立，不逐字段保留混合）。
 *   选「跟随全局」= api_source 清空 + model_params 置 null（消费端判空不启用，回落全局激活源）。
 *
 * 关联链：
 *   → beiluDialog.mjs（beiluConfirm/beiluSelect/beiluPrompt，队列串行）
 *   → sharedState.mjs（getCachedApiSources/getCachedModelList 缓存口）
 *   → sendAction.mjs（updateFlowGroup → 后端 setDataActions:4297 浅 merge）
 *   ← websocket.mjs（建组通知）/ subModePanel.mjs（组详情行）
 *
 * 影响范围：写 work/workflows/<组>.json 的 api_source/model_params 两键；无 localStorage；toast 反馈。
 */
import { beiluSelect, beiluPrompt } from "./beiluDialog.mjs";
import { getCachedApiSources, getCachedModelList } from "../state/sharedState.mjs";
import { sendAction } from "../transport/sendAction.mjs";

/**
 * 弹选源→选模型→写回组 json 的完整更改流程。
 * @param {{filename:string, name:string, api_source?:string, model?:string}} fg - 组投影（listFlowGroups/_flowGroupCreated 形状）
 * @returns {Promise<boolean>} 是否实际写回（用户取消任一步→false）
 */
export async function promptFlowGroupModelChange(fg) {
  if (!fg?.filename) return false;
  let names = [];
  try { names = await getCachedApiSources(); } catch { /* 拉失败→下拉仅剩「跟随全局」，不阻断 */ }
  const src = await beiluSelect(
    `Skill组「${fg.name}」执行期间使用哪个 API 源？`,
    [{ label: "（跟随当前全局源）", value: "" }, ...names.map((n) => ({ label: n, value: n }))],
    { title: "更改 Skill组 API 源", defaultValue: fg.api_source || "" },
  );
  if (src === null) return false; // 取消=不改
  let model = "";
  if (src) {
    const models = await getCachedModelList(src);
    if (models.length) {
      const picked = await beiluSelect(
        "使用哪个模型？",
        [{ label: "（API源默认）", value: "" }, ...models.map((m) => ({ label: m, value: m }))],
        { title: "更改 Skill组模型", defaultValue: fg.model || "" },
      );
      if (picked === null) return false;
      model = picked;
    } else {
      const typed = await beiluPrompt("模型列表拉取失败，手动输入模型名（留空=API源默认）", fg.model || "", { title: "更改 Skill组模型" });
      if (typed === null) return false;
      model = typed.trim();
    }
  }
  try {
    // N36 原子替换：换源=整组重置（旧快照的采样参数属旧源/旧子模式语境，不保留混合）；跟随全局=清快照
    const update = src
      ? { api_source: src, model_params: { api_source: src, ...(model ? { model } : {}) } }
      : { api_source: "", model_params: null };
    const r = await sendAction({ verb: "updateFlowGroup", target: "plugins:beilu-memory", source: "web", payload: { filename: fg.filename, update } });
    if (!r?.success) throw new Error(r?.error || "后端未确认");
    window._beiluToast?.(`Skill组「${fg.name}」已更新：${src ? `${src}${model ? " / " + model : ""}` : "跟随全局源"}`, "success", 3000);
    return true;
  } catch (e) {
    window._beiluToast?.(`Skill组源/模型更新失败: ${e?.message || e}`, "error", 3000);
    return false;
  }
}

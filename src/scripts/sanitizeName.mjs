/**
 * [sanitizeName] — 文件名安全清洗共享原语（0716 轮子收口）。
 *
 * 语义：Windows 非法文件名字符 \ / : * ? " < > | → 下划线 "_"，再 trim 空白。
 * 返回空串时使用 fallback（默认 ""）。
 *
 * 收编散点（收口前各处内联 .replace(/[\\/:*?"<>|]/g, "_")）：
 *   - replyHandler.mjs:1180  — codeMemoryWrite 安全文件名
 *   - replyHandler.mjs:1215  — workMemoryWrite 安全文件名
 *   - replyHandler.mjs:2696  — createFlowGroup 安全文件名
 *   - setDataActions.mjs:3070 — copyToCodeMemory 目标文件名
 *   - setDataActions.mjs:3082 — createCodeFolder 文件夹名
 *   - setDataActions.mjs:3096 — moveCodeFile 目标文件夹名
 *   - setDataActions.mjs:4255 — saveFlowGroup 组名
 *   - setDataActions.mjs:4338 — saveConfigFlowGroup 组名
 *   - endpoints.mjs:2514      — 角色安全文件名
 *   - beilu-home/main.mjs:459 — 角色安全文件名
 *
 * 未收编（语义不同）：
 *   - memtool.mjs:382         — 前端 beilu-chat 壳，跨壳禁 import 后端 scripts
 *   - fileHistory.mjs:54-55   — 双正则组合（safeChatid + safePath），语义不同
 *   - preset/main.mjs:89      — sanitizeFilename 含空白折叠 .replace(/\s+/g, " ").trim()
 *   - presetBridge.mjs:201    — _sanitize 含空白折叠 + .slice(0,100) 截断
 *   - dataSystem.mjs:67       — _safeTaskName 含中文白名单正则
 *
 * 本层为 src/scripts 零依赖共享层，Node/Deno 两上下文通用。
 */

/**
 * 将 Windows 非法文件名字符替换为下划线。
 * @param {string|null|undefined} name - 原始文件名。
 * @param {string} [fallback=""] - name 清洗后为空时的兜底值。
 * @returns {string} 安全文件名。
 */
export function sanitizeFilename(name, fallback = "") {
	const s = String(name ?? "").replace(/[\\/:*?"<>|]/g, "_").trim();
	return s || fallback;
}

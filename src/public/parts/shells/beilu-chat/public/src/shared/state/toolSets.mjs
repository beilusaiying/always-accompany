/**
 * toolSets.mjs — 前端工具集单源（0715 硬编码收口）
 *
 * why：原 messageList.mjs(IDE_WRITE_TOOLS)/workPanel.mjs(_PERM_KEY_TO_B3_TOOLS.file_write)/
 *   permissionPanel.mjs(TOOL_OPTIONS) 三处各持一份工具名清单副本，后端 commandGate.mjs 增删工具时
 *   三处不会跟进（分身扫描 F1/F6/D1 实证：permissionPanel 漏 run_script、messageList 仅 4 项）。
 *   收口为本模块一份：权威 = 后端 commandGate.mjs（FILE_EDIT_TOOLS/PERMISSION_WRITE_TOOLS/WRITE_TOOLS_ALL），
 *   经 getApprovalRules 响应 toolSets 段下发，syncToolSets 覆盖；下方静态默认值只在
 *   后端未下发/离线时兜底（beilu 离线铁律：核心可离线启动，联网增强优雅退化）。
 *
 * 关联链：
 *   ← permissionPanel.mjs loadRules()（getApprovalRules 响应到达时 syncToolSets）
 *   → messageList.mjs（fileEditTools：写类工具 diff 卡判定）
 *   → workPanel.mjs（fileEditTools：file_write toggle → B3 工具映射）
 *   → permissionPanel.mjs（permissionWriteTools+run_command：规则编辑工具下拉）
 */

export const toolSets = {
  // = commandGate.mjs FILE_EDIT_TOOLS（文件编辑类，有 diff 语义）
  fileEditTools: ["write_file", "replace_lines", "insert_at_line", "fuzzy_edit"],
  // = commandGate.mjs PERMISSION_WRITE_TOOLS（B3 权限规则可配的写工具，不含命令类）
  permissionWriteTools: ["write_file", "replace_lines", "insert_at_line", "fuzzy_edit", "todo_write"],
  // = commandGate.mjs WRITE_TOOLS_ALL（全部写类，含命令执行类）
  writeToolsAll: ["write_file", "replace_lines", "insert_at_line", "fuzzy_edit", "run_command", "run_script", "todo_write"],
};

/** 用后端下发的 toolSets 段覆盖静态默认（形状不合法的键忽略，保底不清空）。 */
export function syncToolSets(ts) {
  if (!ts || typeof ts !== "object") return;
  for (const k of ["fileEditTools", "permissionWriteTools", "writeToolsAll"]) {
    if (Array.isArray(ts[k]) && ts[k].length && ts[k].every((t) => typeof t === "string")) {
      toolSets[k] = [...ts[k]];
    }
  }
}

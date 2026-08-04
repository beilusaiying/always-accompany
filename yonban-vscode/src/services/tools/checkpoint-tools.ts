/**
 * checkpoint-tools.ts -- 文件操作检查点工具（快照/回档/溯源 + 操作日志 + 编辑器跳转）
 *
 * ═══════════════════════════════════════════════════════════════
 *  使用链路（每个 tool_call 的完整传导路径）
 * ═══════════════════════════════════════════════════════════════
 *
 * checkpoint 系列（_checkpoint_start/commit/revert/revert_to_message/revert_diff/list/can_replay/get_ops/get_diff）:
 *   用户想撤销 AI 的文件修改 / AI 管理操作批次
 *     → beilu 后端发 _checkpoint_* 内部 tool_call
 *     → 薄包装委托 FileCheckpoint 实例方法
 *     → FileCheckpoint 管理内存快照 + 磁盘持久化
 *     → 回档时原子写盘恢复文件（revert/revertToMessage）
 *     → 用户看到文件被恢复到之前状态
 *
 * getOpLog:
 *   AI 查询最近的 IDE 操作日志
 *     → tool_call get_op_log { count?, filter? }
 *     → 读取 tool-infra 的内存日志缓冲
 *     → 返回 { count, logs } 给 AI
 *
 * _reveal:
 *   用户在 webview 点击 diff 行跳转到编辑器
 *     → tool_call _reveal { path, anchorText?, line? }
 *     → locateLineByAnchor 按内容锚定位当前行（抗行号漂移）
 *     → revealAndHighlight 在编辑器打开+跳转+3s 绿色高亮
 *     → 用户看到编辑器跳转到对应位置
 *
 * 相交：
 *   ← ToolExecutor.ts execute（_handlers 注册表路由到此）
 *   → FileCheckpoint.ts（快照/回档/溯源的核心实现）
 *   → EditorReveal.ts（revealAndHighlight + locateLineByAnchor）
 *   → tool-infra.ts（getIdeOperationLog + resolveWorkspacePath）
 */
import * as fs from "fs";
import { FileCheckpoint } from "../FileCheckpoint";
import { revealAndHighlight, locateLineByAnchor } from "../EditorReveal";
import { getIdeOperationLog, resolveWorkspacePath } from "../tool-infra";

function requireNonEmptyString(
  params: Record<string, unknown>,
  key: string,
): string {
  const value = params[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("缺少或无效的 " + key + " 参数");
  }
  return value;
}

function requireNonNegativeInteger(
  params: Record<string, unknown>,
  key: string,
): number {
  const value = params[key];
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new Error(key + " 必须是有限非负整数");
  }
  return value;
}

function optionalStringArray(
  params: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error(key + " 必须是非空字符串数组");
  }
  if (new Set(value).size !== value.length) {
    throw new Error(key + " 不能包含重复项");
  }
  return [...value];
}

export async function checkpointStart(
  params: Record<string, unknown>,
  checkpoint: FileCheckpoint,
): Promise<unknown> {
  const id = requireNonEmptyString(params, "id");
  const chatId = requireNonEmptyString(params, "chatId");
  const messageIndex = requireNonNegativeInteger(params, "messageIndex");
  const messageId = params.messageId === undefined
    ? undefined
    : requireNonEmptyString(params, "messageId");
  const deferred = !!params.deferred;
  checkpoint.start(id, chatId, messageIndex, deferred, messageId);
  return { success: true, id };
}

export async function checkpointCommit(
  params: Record<string, unknown>,
  checkpoint: FileCheckpoint,
): Promise<unknown> {
  const id = params.id as string;
  if (!id) throw new Error("缺少 id 参数");
  return { id, ...checkpoint.commit(id) };
}

export async function checkpointRevert(
  params: Record<string, unknown>,
  checkpoint: FileCheckpoint,
): Promise<unknown> {
  const id = params.id as string;
  if (!id) throw new Error("缺少 id 参数");
  return checkpoint.revert(id);
}

export async function checkpointRevertToMessage(
  params: Record<string, unknown>,
  checkpoint: FileCheckpoint,
): Promise<unknown> {
  const chatId = requireNonEmptyString(params, "chatId");
  const targetIndex = requireNonNegativeInteger(params, "targetIndex");
  const expectedCheckpointIds = optionalStringArray(params, "expectedCheckpointIds");
  return checkpoint.revertToMessage(chatId, targetIndex, expectedCheckpointIds);
}

/** 只读：预览回档到 targetIndex 会还原/删除哪些文件，不改任何状态 */
export async function checkpointRevertDiff(
  params: Record<string, unknown>,
  checkpoint: FileCheckpoint,
): Promise<unknown> {
  const chatId = requireNonEmptyString(params, "chatId");
  const targetIndex = requireNonNegativeInteger(params, "targetIndex");
  const expectedCheckpointIds = optionalStringArray(params, "expectedCheckpointIds");
  return checkpoint.getRevertToMessageDiff(chatId, targetIndex, expectedCheckpointIds);
}

export async function checkpointList(
  checkpoint: FileCheckpoint,
): Promise<unknown> {
  return { checkpoints: checkpoint.list() };
}

export async function checkpointCanReplay(
  params: Record<string, unknown>,
  checkpoint: FileCheckpoint,
): Promise<unknown> {
  const id = params.id as string;
  if (!id) throw new Error("缺少 id 参数");
  return checkpoint.canReplay(id);
}

export async function checkpointGetOps(
  params: Record<string, unknown>,
  checkpoint: FileCheckpoint,
): Promise<unknown> {
  const id = params.id as string;
  if (!id) throw new Error("缺少 id 参数");
  const ops = checkpoint.getOperations(id);
  if (!ops) return { success: false, error: `检查点不存在: ${id}` };
  return { success: true, operations: ops };
}

export async function checkpointGetDiff(
  params: Record<string, unknown>,
  checkpoint: FileCheckpoint,
): Promise<unknown> {
  const id = params.id as string;
  if (!id) throw new Error("缺少 id 参数");
  const diff = checkpoint.getDiff(id);
  if (!diff) return { success: false, error: `检查点不存在: ${id}` };
  return { success: true, files: diff };
}

/** 查询IDE操作日志 */
export async function getOpLog(params: Record<string, unknown>): Promise<unknown> {
  const n = typeof params.count === "number" ? params.count : 50;
  const filter = params.filter as string | undefined;
  let logs = getIdeOperationLog(Math.min(n as number, 200));
  if (filter) {
    logs = logs.filter(l => l.tool.includes(filter) || l.act.includes(filter) || l.st === filter);
  }
  return { count: logs.length, logs };
}

/**
 * 内部工具 `_reveal`：UI「点击 diff 跳转」用。按内容锚 anchorText 在文件里定位**当前**行（抗行号漂移——
 * 行号变了也能靠内容找到），调 revealAndHighlight 在编辑器打开+跳转+高亮。走 callTool 不入 _pendingResults，
 * 不污染 AI 对话。找不到锚则回退 line 参/第1行。
 */
export async function _reveal(params: Record<string, unknown>): Promise<unknown> {
  const filePath = params.path as string;
  if (!filePath) throw new Error("缺少 path 参数");
  const absPath = resolveWorkspacePath(filePath);
  if (!fs.existsSync(absPath)) throw new Error(`文件不存在: ${filePath}`);
  const anchorText = typeof params.anchorText === "string" ? params.anchorText.trim() : "";
  const fallback = typeof params.line === "number" && params.line > 0 ? params.line : 1;
  // 内容锚定位单源:与 EditorReveal.revealAndHighlight 复用同一 locateLineByAnchor(消重复 findIndex)
  const { line, matched } = locateLineByAnchor(absPath, anchorText, fallback);
  await revealAndHighlight(absPath, line, 1);
  return { revealed: true, line, anchorMatched: matched, path: filePath };
}

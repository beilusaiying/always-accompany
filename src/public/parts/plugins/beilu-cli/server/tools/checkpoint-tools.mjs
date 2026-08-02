/**
 * checkpoint-tools.mjs — 检查点工具（从 YonBan checkpoint-tools.ts 移植）
 * _reveal 在 CLI 模式下输出 file:line 信息（无编辑器可跳）
 */
import * as fs from "node:fs";
import { resolveWorkspacePath, getIdeOperationLog } from "../infra.mjs";

export async function checkpointStart(params, checkpoint) {
  const id = params.id;
  if (!id) throw new Error("缺少 id 参数");
  const chatId = typeof params.chatId === "string" ? params.chatId : "";
  const messageIndex = typeof params.messageIndex === "number" ? params.messageIndex : 0;
  const deferred = params.deferred === true;
  checkpoint.start(id, chatId, messageIndex, deferred);
  return { success: true, id, message: `检查点已${deferred ? "登记(deferred)" : "开始"}` };
}

export async function checkpointCommit(params, checkpoint) {
  const id = params.id;
  if (!id) throw new Error("缺少 id 参数");
  checkpoint.commit(id);
  return { success: true, id, message: "检查点已提交" };
}

export async function checkpointRevert(params, checkpoint) {
  const id = params.id;
  if (!id) throw new Error("缺少 id 参数");
  return checkpoint.revert(id);
}

export async function checkpointRevertToMessage(params, checkpoint) {
  const chatId = typeof params.chatId === "string" ? params.chatId : "";
  const targetIndex = typeof params.targetIndex === "number" ? params.targetIndex : 0;
  return checkpoint.revertToMessage(chatId, targetIndex);
}

export async function checkpointRevertDiff(params, checkpoint) {
  const chatId = typeof params.chatId === "string" ? params.chatId : "";
  const targetIndex = typeof params.targetIndex === "number" ? params.targetIndex : 0;
  return checkpoint.getRevertToMessageDiff(chatId, targetIndex);
}

export async function checkpointList(checkpoint) {
  return checkpoint.list();
}

export async function checkpointCanReplay(params, checkpoint) {
  const id = params.id;
  if (!id) throw new Error("缺少 id 参数");
  return checkpoint.canReplay(id);
}

export async function checkpointGetOps(params, checkpoint) {
  const id = params.id;
  if (!id) throw new Error("缺少 id 参数");
  return checkpoint.getOperations(id);
}

export async function checkpointGetDiff(params, checkpoint) {
  const id = params.id;
  if (!id) throw new Error("缺少 id 参数");
  return checkpoint.getDiff(id);
}

export async function getOpLog(params) {
  const count = Math.min(Math.max(Number(params?.count) || 50, 1), 200);
  const filter = typeof params?.filter === "string" ? params.filter : "";
  let logs = getIdeOperationLog(count);
  if (filter) {
    logs = logs.filter((l) =>
      l.tool?.includes(filter) || l.act?.includes(filter) || l.st?.includes(filter)
    );
  }
  return { count: logs.length, logs };
}

export async function _reveal(params) {
  const filePath = typeof params.path === "string" ? params.path : "";
  if (!filePath) throw new Error("缺少 path 参数");
  const absPath = resolveWorkspacePath(filePath);
  let line = typeof params.line === "number" ? params.line : 1;
  const anchorText = typeof params.anchorText === "string" ? params.anchorText : "";

  // CLI 模式下用内容锚定定位行号
  if (anchorText && fs.existsSync(absPath)) {
    try {
      const content = fs.readFileSync(absPath, "utf-8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(anchorText)) {
          line = i + 1;
          return { revealed: true, line, anchorMatched: true, path: filePath };
        }
      }
    } catch { /* fallback to given line */ }
  }
  return { revealed: true, line, anchorMatched: false, path: filePath };
}

/**
 * todo-tools.ts -- 任务清单读写工具（.beilu/todo.md）
 *
 * ═══════════════════════════════════════════════════════════════
 *  使用链路（每个 tool_call 的完整传导路径）
 * ═══════════════════════════════════════════════════════════════
 *
 * todoRead:
 *   AI 需要查看当前任务列表
 *     → tool_call todo_read
 *     → 读取 {wsRoot}/.beilu/todo.md
 *     → 返回 { path, content, exists, size? } 给 AI
 *     → AI 据此决定下一步任务
 *
 * todoWrite:
 *   AI 更新任务清单（增删改任务项）
 *     → tool_call todo_write { content }
 *     → 写入 {wsRoot}/.beilu/todo.md（自动创建 .beilu 目录）
 *     → 返回 { path, size, message } 给 AI
 *     → 用户可在文件系统中查看更新后的清单
 *
 * 相交：
 *   ← ToolExecutor.ts execute（_handlers 注册表路由到此）
 *   → tool-infra.ts getWorkspaceRoot（获取工作区根目录）
 */
import * as fs from "fs";
import * as path from "path";
import { getWorkspaceRoot } from "../tool-infra";

/** 读取任务清单 */
export async function todoRead(): Promise<unknown> {
  const wsRoot = getWorkspaceRoot();
  const todoPath = path.join(wsRoot, ".beilu", "todo.md");

  if (!fs.existsSync(todoPath)) {
    return {
      path: ".beilu/todo.md",
      content: "",
      exists: false,
      message: "任务清单不存在",
    };
  }

  const content = fs.readFileSync(todoPath, "utf-8");
  return {
    path: ".beilu/todo.md",
    content,
    exists: true,
    size: Buffer.byteLength(content, "utf-8"),
  };
}

/** 写入任务清单 */
export async function todoWrite(params: Record<string, unknown>): Promise<unknown> {
  const content = params.content as string;
  if (content === undefined || content === null)
    throw new Error("缺少 content 参数");

  const wsRoot = getWorkspaceRoot();
  const todoDir = path.join(wsRoot, ".beilu");
  const todoPath = path.join(todoDir, "todo.md");

  if (!fs.existsSync(todoDir)) {
    fs.mkdirSync(todoDir, { recursive: true });
  }

  fs.writeFileSync(todoPath, content, "utf-8");
  return {
    path: ".beilu/todo.md",
    size: Buffer.byteLength(content, "utf-8"),
    message: "任务清单已更新",
  };
}

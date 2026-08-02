/**
 * todo-tools.mjs — 任务清单读写（从 YonBan todo-tools.ts 1:1 移植）
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getWorkspaceRoot } from "../infra.mjs";

export async function todoRead() {
  const wsRoot = getWorkspaceRoot();
  const todoPath = path.join(wsRoot, ".beilu", "todo.md");
  if (!fs.existsSync(todoPath)) {
    return { path: ".beilu/todo.md", content: "", exists: false, message: "任务清单不存在" };
  }
  const content = fs.readFileSync(todoPath, "utf-8");
  return { path: ".beilu/todo.md", content, exists: true, size: Buffer.byteLength(content, "utf-8") };
}

export async function todoWrite(params) {
  const content = params.content;
  if (content === undefined || content === null) throw new Error("缺少 content 参数");
  const wsRoot = getWorkspaceRoot();
  const todoDir = path.join(wsRoot, ".beilu");
  const todoPath = path.join(todoDir, "todo.md");
  if (!fs.existsSync(todoDir)) fs.mkdirSync(todoDir, { recursive: true });
  fs.writeFileSync(todoPath, content, "utf-8");
  return { path: ".beilu/todo.md", size: Buffer.byteLength(content, "utf-8"), message: "任务清单已更新" };
}

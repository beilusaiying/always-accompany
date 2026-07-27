/**
 * taskStore.mjs — F3「AI 制定任务 + 打勾」数据底座（工作内容清单 CRUD）。
 *
 * 【功能链】
 *   提供任务清单的完整生命周期管理：
 *   - resolveTasksPath：解析 tasks.json 物理路径（经 getModeCtxDir 单一权威，恒角色卡级 <memDir>/tasks.json；
 *     20260726 定案后 chatId 不再是隔离维度，见 :89 附近 getModeCtxDir 调用注释）
 *   - loadTasks：读取任务底座（缺文件返回空底座，不抛）
 *   - appendTask：追加新任务（AI <taskPlan> 标签创建 / 用户手动添加）
 *   - applyTaskPlan：批量创建/更新任务清单（AI 一次性制定整套计划）
 *   - applyTaskCheck：按 id 更新任务状态（pending → in_progress → completed，AI 打勾）
 *   - mutateTasks：低级写操作（setDataActions 直接操作任务数组）
 *   - remainingCount：统计未完成任务数（供 GetPrompt 判断是否需要继续）
 *   rev 乐观并发：每次写盘 +1，防止并发写覆盖（简化版，无冲突检测，依赖 withFileLock 串行化）。
 *
 * 【why】
 *   G2 新范式（凛倾 2026-06-10）：进度用任务清单表达，不再靠切换模式（modeSwitch）表达。
 *   任务清单落独立文件（不进 chat log，不进 tables）有三个好处：
 *   1. 不污染对话历史（用户不希望看到内部任务管理消息）
 *   2. 不占 tables token 配额（tables 注入每轮有大小限制）
 *   3. 可被 GetPrompt 按需注入任务清单摘要，AI 知道当前剩余任务
 *   20260726 定案：隔离维度改为 用户级 + 角色卡级，对话（chatId）不再是隔离维度（原 per-chatId
 *   分窗已退役——实测 60 个任务碎在 9 份 tasks.json 里，换对话就看不见，删对话连带丢失）。
 *
 * 【前端调用方式】
 *   AI 路径（AI 制定计划）：
 *     AI 回复 <taskPlan> → replyHandler → applyTaskPlan() → 写 tasks.json → 广播 task_update
 *   AI 路径（AI 打勾）：
 *     AI 回复 <taskCheck> → replyHandler → applyTaskCheck() → 写 tasks.json → 广播 task_update
 *   前端手动路径：
 *     SetData("taskPlan"/"taskCheck", {...}) → setDataActions → applyTaskPlan/applyTaskCheck()
 *   前端感知：
 *     WS broadcast "task_update" / "cross_mode_task_update" → 前端任务清单面板实时刷新
 *     （注释校准 2026-07-16：原写"GetData 返回的 data_system.tasks 初始渲染"不实——getDataHandler
 *     从不在 data_system 上挂 tasks，前端初始加载走 setdata verb（taskItemPanel sendAction）+ WS 刷新）
 *
 * 【关联链】
 *   ← replyHandler.mjs（applyTaskPlan / applyTaskCheck / appendTask — AI 标签驱动）
 *   ← setDataActions.mjs（mutateTasks / appendTask / remainingCount — 用户操作）
 *   ← getPromptHandler.mjs（loadTasks / remainingCount — 注入任务摘要到 prompt）
 *   → storage.mjs（getMemoryDir / getModeCtxDir / loadJsonFile / saveJsonFile / withFileLock / ensureMemoryDir / diag）
 *   存储：恒 memDir/tasks.json（角色卡级，20260726 定案后 chatId 不再分窗；
 *         resolveTasksPath 仍接收 mode/chatId 参数但 getModeCtxDir 内部恒返回 memDir，不再按其分流）
 *
 * 【影响范围】
 *   - 写 tasks.json（任务清单，角色卡级，非 per-chatId 分窗）
 *   - 不直接广播 WS（广播由调用方 replyHandler 在返回值基础上执行）
 *   - 不写 tables.json / chat log（任务清单完全独立于记忆体系和对话历史）
 *
 * 【使用效果】
 *   AI 可以制定多步骤任务计划，逐步执行后逐项打勾，
 *   前端任务面板实时反映完成进度，GetPrompt 注入剩余任务数让 AI 知道下轮还需完成什么。
 *
 * flowGroup steps（角色流转编排）与 tasks（工作内容清单）两轴正交（§1.4），本模块只管 tasks。
 * 依赖方向：taskStore ← replyHandler / setDataActions。本模块仅依赖 storage（无兄弟环）。
 */

import fs from "node:fs";
import path from "node:path";

import {
  diag,
  ensureMemoryDir,
  getMemoryDir,
  getModeCtxDir,
  loadJsonFile,
  saveJsonFile,
  withFileLock,
} from "../storage_mod/storage.mjs";

const TASKS_FILE = "tasks.json";

/** 空底座（缺文件时的默认值）。 */
function _emptyStore() {
  return { tasks: [], rev: 0 };
}

/**
 * 解析 tasks.json 的物理路径。
 *
 * 经 getModeCtxDir 单一权威解析 → 恒 `<memDir>/tasks.json`（角色卡级）。
 *   20260726 定案：隔离只有用户级 + 角色卡级，对话不是维度（原 `<mode>_ctx/<chatId>/tasks.json`
 *   按对话切分已退役——实测 60 个任务碎在 9 份 tasks.json 里，换对话就看不见，删对话连带丢失）。
 *
 * @param {string} username
 * @param {string} charName
 * @param {string} mode  "chat" | "code" | "work"
 * @param {string} [chatId]
 * @returns {{ dir: string, file: string }}
 */
export function resolveTasksPath(username, charName, mode, chatId) {
  const memDir = getMemoryDir(username, charName);
  // 全模式角色卡级：getModeCtxDir 恒返回 memDir（对话维度已退役，路径单点仍收口在该函数）。
  const dir = getModeCtxDir(memDir, mode, chatId);
  return { dir, file: path.join(dir, TASKS_FILE) };
}

/**
 * 读取任务底座（缺文件返回空底座，不抛）。
 * @returns {{ tasks: object[], rev: number }}
 */
export function loadTasks(username, charName, mode, chatId) {
  const { file } = resolveTasksPath(username, charName, mode, chatId);
  if (!fs.existsSync(file)) return _emptyStore();
  const data = loadJsonFile(file);
  if (!data || !Array.isArray(data.tasks)) {
    diag.warn(`taskStore.loadTasks: ${file} 损坏/格式异常, 返回空底座`);
    return _emptyStore();
  }
  return { tasks: data.tasks, rev: typeof data.rev === "number" ? data.rev : 0 };
}

/** 生成稳定的任务 id（无 crypto 依赖，毫秒+随机后缀足够防撞）。 */
function _genTaskId() {
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

const _VALID_STATUS = new Set(["pending", "in_progress", "completed"]);

/** 规整单条任务，补全缺省字段。 */
function _normalizeTask(raw, nowIso) {
  const status = _VALID_STATUS.has(raw?.status) ? raw.status : "pending";
  return {
    id: raw?.id ? String(raw.id) : _genTaskId(),
    content: String(raw?.content ?? "").trim(),
    status,
    priority: raw?.priority != null ? String(raw.priority) : "normal",
    createdAt: raw?.createdAt || nowIso,
    completedAt:
      status === "completed" ? raw?.completedAt || nowIso : raw?.completedAt || null,
  };
}

/**
 * 串行写盘（withFileLock 防 lost-update），rev 自增。
 * @param {(store:{tasks:object[],rev:number}) => {tasks:object[]} | void} mutator
 *        接收当前底座副本，返回新 tasks（或原地改 store.tasks 后返回 void）。
 * @returns {Promise<{ tasks: object[], rev: number }>} 写盘后的底座
 */
export async function mutateTasks(username, charName, mode, chatId, mutator) {
  ensureMemoryDir(username, charName);
  const { dir, file } = resolveTasksPath(username, charName, mode, chatId);
  return withFileLock(file, async () => {
    const cur = loadTasks(username, charName, mode, chatId);
    const next = mutator(cur);
    const tasks = (next && next.tasks) || cur.tasks;
    const out = { tasks, rev: (cur.rev || 0) + 1 };
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    saveJsonFile(file, out);
    diag.debug(
      `taskStore.mutateTasks: ${file} -> ${tasks.length}项 rev=${out.rev}`,
    );
    return out;
  });
}

/**
 * <taskPlan> 全量替换：AI 制定/更新整张清单（KILO TodoWrite 范式）。
 * @param {Array<{content,status?,priority?,id?}>} rawTasks
 */
export async function applyTaskPlan(username, charName, mode, chatId, rawTasks) {
  const nowIso = new Date().toISOString();
  return mutateTasks(username, charName, mode, chatId, (cur) => {
    // 保留已有任务的 createdAt：按 content 匹配旧条目继承时间戳，避免每轮 plan 重置创建时间。
    const _oldByContent = new Map(cur.tasks.map((t) => [t.content, t]));
    const tasks = (rawTasks || [])
      .filter((t) => t && String(t.content ?? "").trim())
      .map((t) => {
        const _old = _oldByContent.get(String(t.content).trim());
        return _normalizeTask(
          {
            ...t,
            id: t.id || _old?.id,
            createdAt: t.createdAt || _old?.createdAt,
            completedAt:
              t.status === "completed"
                ? t.completedAt || _old?.completedAt
                : null,
          },
          nowIso,
        );
      });
    return { tasks };
  });
}

/**
 * 追加单条任务（原子：withFileLock 内 push，消除调用方 getTasks→planTasks 读改写竞态）。
 * @param {{content:string,status?:string,priority?:string}} raw
 */
export async function appendTask(username, charName, mode, chatId, raw) {
  const nowIso = new Date().toISOString();
  return mutateTasks(username, charName, mode, chatId, (cur) => {
    cur.tasks.push(_normalizeTask(raw, nowIso));
    return { tasks: cur.tasks };
  });
}

/**
 * <taskCheck> 勾掉一项：按 id 或 content 命中，置 status=completed + completedAt。
 * @param {{ id?: string, content?: string, status?: string }} sel
 * @returns {Promise<{ store:{tasks,rev}, matched: boolean }>}
 */
export async function applyTaskCheck(username, charName, mode, chatId, sel) {
  const nowIso = new Date().toISOString();
  let matched = false;
  const newStatus = _VALID_STATUS.has(sel?.status) ? sel.status : "completed";
  const store = await mutateTasks(username, charName, mode, chatId, (cur) => {
    const _id = sel?.id ? String(sel.id) : "";
    const _content = sel?.content ? String(sel.content).trim() : "";
    for (const t of cur.tasks) {
      const hit = (_id && t.id === _id) || (_content && t.content === _content);
      if (!hit) continue;
      matched = true;
      t.status = newStatus;
      t.completedAt = newStatus === "completed" ? nowIso : null;
      break; // 只勾一项
    }
    return { tasks: cur.tasks };
  });
  return { store, matched };
}

/** 剩余（未完成）项数，前端「剩余 N 项」用。 */
export function remainingCount(store) {
  if (!store || !Array.isArray(store.tasks)) return 0;
  return store.tasks.filter((t) => t.status !== "completed").length;
}

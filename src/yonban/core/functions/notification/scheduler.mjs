/**
 * scheduler.mjs — 定时任务调度器（后台定时触发引擎；模式授权由 ModeDef features.scheduler 声明驱动）。
 *
 * 【功能链】
 *   维护一个按 username/charName 隔离的 Job 状态机（Map），
 *   自适应 tick（5s–2min，按最近任务到期时间动态调整间隔）检查并执行到期任务，
 *   执行时经 dispatch → bus:activate 出口节点分发 auto_reply / wake（07-02 搭线：调度流走计算图的边；
 *   inject / table_update 仍由 GetPrompt 被动注入，不经激活线）。
 *   AI 可通过 <scheduleTask> 标签在 replyHandler 中创建/更新任务；
 *   用户可通过 SetData("addJob"/"removeJob"/"updateJob") 在 setDataActions 中操作任务。
 *   支持 cron（简化格式）/ interval（固定间隔）/ once（单次）三种调度类型。
 *
 * 【why】
 *   work 模式下 AI 需要在无用户消息时主动触发操作（如定时汇报进度、周期性检查任务），
 *   这不能靠 generation.mjs 的 GetPrompt 钩子实现（GetPrompt 是被动触发）。
 *   Scheduler 作为独立后台 loop，在用户不活跃时仍能触发 AI 回合。
 *   自适应 tick 而非固定 setInterval，是为了在无任务时（2min tick）不空转浪费，
 *   在任务即将到期时（5s tick）保证精度。
 *
 * 【前端调用方式】
 *   前端调用路径（任务管理）：
 *     SetData("addJob", { job }) → setDataActions → addJob() → _saveJobs() → 落盘
 *     SetData("removeJob", { id }) → setDataActions → removeJob()
 *     SetData("listJobs") → setDataActions → listJobs()（通过 getDataHandler 聚合返回）
 *   AI 路径：
 *     AI 回复含 <scheduleTask> → replyHandler → parseScheduleTaskTag() → addJob()
 *   Scheduler 触发动作后前端感知：
 *     - auto_reply/wake → dispatchActivation → triggerCharReply → AI 生成 → 正常对话流程
 *     - inject → 下轮 GetPrompt 时注入到期任务提醒（无额外广播）
 *
 * 【关联链】
 *   ← setDataActions.mjs（addJob / removeJob / updateJob / listJobs + switchMode 按 schedulerFeature(mode).enabled 启停 + scheduler_start/stop 显式口）
 *   ← replyHandler.mjs（parseScheduleTaskTag → addJob 创建 AI 生成的任务）
 *   ← generation.mjs（runCodeRoundTriggers 代码轮次触发，未启动时自举）
 *   ← getPromptHandler.mjs（getDueJobsText — 到期提醒注入，schedulerFeature(mode).dueJobsInject 门）
 *   ← pipelines/_runtime/runner.mjs（loadModeDefs 注册钩 → storage.registerModeFeatures 填通用声明表，本域经 modeFeature 消费）
 *   → core/dispatch/dispatcher.mjs + exits.mjs bus:activate → dispatchActivation.mjs（到期任务分发，07-02 搭线后经计算图的边）
 *   → storage.mjs（getMemoryDir / saveJsonFile / getActiveMode）
 *   存储：memory/{char}/work/_work_config.json 的 scheduled_tasks 数组
 *
 * 【影响范围】
 *   - 内存：_schedulerState Map（按 username/charName 隔离的 timer + jobs 状态）
 *   - 写磁盘：_work_config.json 的 scheduled_tasks（CRUD 操作时）
 *   - 触发下游：dispatchActivation 可触发 AI 生成（auto_reply/wake）或 GetPrompt 注入提醒（inject）
 *   - 不广播 WS 事件（由 dispatchActivation 下游自行广播）
 *
 * 【使用效果】
 *   work 模式下 AI 可自主创建和管理定时任务（日程提醒、周期汇报、定时检查），
 *   到期后自动唤醒对话或注入提醒，无需用户手动触发。
 *
 * 参考：W03_任务调度系统.md + OpenClaw cron-tool
 */

import fs from "node:fs";
import path from "node:path";
import { saveJsonFile, getMemoryDir, getActiveMode, getWorkConfigPath, getUserDataDir, modeFeature, getYonbanConfigPath, withFileLock } from "../memory/storage_mod/storage.mjs"; // T8·回切：改组内引用（T3a·3.9 暂指旧位壳的欠账，T3e memory 已入住）；withFileLock=[0722 锁收口] _saveJobs 与流程组写者同锁
import { wbT, wbD } from "../../../../server/wbStub.mjs"; // T3a·3.9: 新位 4 级回溯 src/
import { readJsonSafeSync } from "../../../../scripts/safeJsonIO.mjs"; // 0716 T019 差集收编：work_config 损坏不再静默返空（防空表写回销毁定时任务）

// ============================================================
// 常量
// ============================================================

// ── yonban 搭线（凛倾 07-02"自驱动搭线"）：到期激活改走计算图的边 ──
// dispatch → bus:activate 出口节点 → 同一 dispatchActivation 实现（exits.mjs 懒加载同一模块缓存，
// 行为等价；边上多一条 wbSpan 白盒可观测）。动态 import 防止把 dispatch 层静态耦合进 parts
// 加载时序（同 dispatchActivation 自身的跨 part 动态 import 范式）。
async function _busActivate(intent) {
	const [{ dispatch }] = await Promise.all([
		import("../../dispatch/dispatcher.mjs"),
		import("../../dispatch/exits.mjs"), // 副作用 import：注册 bus:* 出口节点（模块缓存只注册一次）
	]);
	return dispatch({
		verb: "activate", target: "bus:activate", source: "scheduler",
		payload: intent, scope: { chatId: intent?.chatid ?? null },
	});
}

const TICK_INTERVAL_MS = 30_000; // 30秒基准(无任务时)
const TICK_MIN_MS = 5_000;       // 最快5秒(任务即将到期)
const TICK_MAX_MS = 120_000;     // 最慢2分钟(无启用任务时节省空转)

function _calcAdaptiveInterval(jobs) {
  if (!jobs || jobs.length === 0) return TICK_MAX_MS;
  const now = Date.now();
  let nearest = Infinity;
  for (const job of jobs) {
    if (!job.enabled || !job.nextRunAt) continue;
    const diff = new Date(job.nextRunAt).getTime() - now;
    if (diff < nearest) nearest = diff;
  }
  if (nearest === Infinity) return TICK_MAX_MS;
  if (nearest <= 0) return TICK_MIN_MS;
  return Math.max(TICK_MIN_MS, Math.min(nearest * 0.8, TICK_MAX_MS));
}

// ============================================================
// 状态（按 username/charName 隔离）
// ============================================================

/** @type {Map<string, { timer: NodeJS.Timeout, jobs: Array }>} */
const _schedulerState = new Map();

// ============================================================
// 模式声明消费（scheduler 域裁决口）
// ============================================================
// ModeDef features.scheduler 是本域行为的唯一声明源（modes/*.json），
// 经 storage.modeFeature 通用只读镜像取值（runner.loadModeDefs 注册钩填表，全域单表——
// 0716 接线批把域私表升级为通用表，防每域一钩一表的系统性重复）。
// 消费方（本文件 _tick/runCodeRoundTriggers + setDataActions switchMode + getPromptHandler 到期注入）
// 一律经 schedulerFeature(mode) 取值，禁止再写 mode==="work" 类硬编码模式名门。

/**
 * scheduler 域裁决：mode 的调度行为授权（值全部来自 ModeDef 声明，无代码内置模式名）。
 * 注册未达/未知模式 → 全 false 诚实降级（wbT modeGate 留痕可诊断）。
 */
export function schedulerFeature(mode) {
  const f = modeFeature(mode, "scheduler");
  return {
    enabled: f.enabled,                                  // 生命周期：切入该模式是否常驻调度器
    dueJobsInject: f.config.dueJobsInject === true,      // 到期呈现：GetPrompt 注入提醒
    crossWindowWake: f.config.crossWindowWake === true,  // 到期呈现：激活窗口（wake/auto_reply）——多窗口=激活语义
    codeRoundTriggers: f.config.codeRoundTriggers === true, // 轮次驱动：代码轮触发器
  };
}

// 预热：拉一次 loadModeDefs 让注册钩填表，关「重启后首次生成前」的注册时序洞
// （storage.mjs registerModeIds 同款洞的本域关法——否则重启后用户先切模式会被 miss 全 false 误停调度器）。
// loadModeDefs 的 validateModeDef 依赖 dispatch registry（功能随 parts 装载渐满，早调=fail loud 抛
// 「点了未注册功能」，Deno 单测实抓）——故带重试等 registry 就绪，同 storage auth 桥「取到前回退」纪律。
function _preheatModeDefs(attempt = 0) {
  import("../../../pipelines/_runtime/runner.mjs")
    .then((m) => m.loadModeDefs?.())
    .catch((e) => {
      if (attempt < 12) setTimeout(() => _preheatModeDefs(attempt + 1), 2500);
      else console.warn(`[beilu-scheduler] ModeDef 预热放弃（registry 未就绪？）: ${e?.message}`);
    });
}
_preheatModeDefs();

// ============================================================
// 生命周期
// ============================================================

/**
 * 启动调度器。调用方：switchMode（schedulerFeature(mode).enabled=true 的模式切入时）、
 * scheduler_start 显式 action、runCodeRoundTriggers 自举。幂等（已启动直接返回）。
 * @param {string} username
 * @param {string} charName
 * @param {string} memDir - memory/{char}/ 绝对路径
 */
export function startScheduler(username, charName, memDir) {
  const key = `${username}/${charName}`;
  wbT(null, "scheduler", "startScheduler:enter", { username, charName, memDir });
  if (_schedulerState.has(key)) return; // 已启动

  const jobs = _loadJobs(username, charName);

  function _scheduleNext() {
    if (!_schedulerState.has(key)) return;
    _tick(key, memDir);
    const state = _schedulerState.get(key);
    if (!state) return;
    const interval = _calcAdaptiveInterval(state.jobs);
    state.timer = setTimeout(_scheduleNext, interval);
  }
  const timer = setTimeout(_scheduleNext, TICK_INTERVAL_MS);

  _schedulerState.set(key, { timer, jobs, memDir, username, charName });
  wbT(null, "scheduler", "startScheduler:started", { key, jobCount: jobs.length });
  console.log(`[beilu-scheduler] 启动: ${key}, ${jobs.length}个任务`);
}

/**
 * 停止调度器
 */
export function stopScheduler(username, charName) {
  const key = `${username}/${charName}`;
  wbT(null, "scheduler", "stopScheduler:enter", { key });
  const state = _schedulerState.get(key);
  if (state) {
    clearTimeout(state.timer);
    _schedulerState.delete(key);
    wbT(null, "scheduler", "stopScheduler:stopped", { key });
    console.log(`[beilu-scheduler] 停止: ${key}`);
  }
}

/**
 * 启动恢复：进程重启后把「有启用任务」的 user/char 的调度器拉起（memory main.mjs Load 调用，fire-and-forget）。
 * why：startScheduler 只挂在 switchMode/scheduler_start/code_round 自举——重启后用户不切模式，
 *   已建定时任务就静默停摆（死配置：配置了却不生效）。头注释曾声称「Load 钩子初始化」但从未接线（2026-07-16 grep 证伪补接）。
 * 用户枚举走 auth.getAllUserNames 权威口；auth config 未就绪（server init 时序）→ 10s 后重试一次，再失败留痕放弃。
 * 只拉「有 enabled job」的 char——不给空任务表造常驻 timer；到期动作仍逐 job 过 schedulerFeature 声明门。
 */
export async function resumeSchedulers({ _retry = false } = {}) {
  let users;
  try {
    const auth = await import("../security/auth.mjs");
    users = auth.getAllUserNames?.() || [];
  } catch (e) {
    if (!_retry) {
      setTimeout(() => { resumeSchedulers({ _retry: true }); }, 10_000);
      return;
    }
    console.warn(`[beilu-scheduler] 启动恢复放弃（auth 不可用）: ${e?.message}`);
    return;
  }
  let resumed = 0;
  for (const u of users) {
    let entries = [];
    try {
      entries = fs.readdirSync(path.join(getUserDataDir(u), "chars"), { withFileTypes: true });
    } catch { continue; } // 无 chars 目录=该用户无卡
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      try {
        if (!_loadJobs(u, ent.name).some((j) => j.enabled)) continue;
        startScheduler(u, ent.name, getMemoryDir(u, ent.name));
        resumed++;
      } catch (e) {
        console.warn(`[beilu-scheduler] 启动恢复失败 ${u}/${ent.name}: ${e?.message}`);
      }
    }
  }
  if (resumed) console.log(`[beilu-scheduler] 启动恢复: ${resumed} 个调度器`);
}

/**
 * 停止所有调度器（Unload 时调用）
 */
export function stopAllSchedulers() {
  for (const [key, state] of _schedulerState) {
    clearTimeout(state.timer);
    console.log(`[beilu-scheduler] 停止: ${key}`);
  }
  _schedulerState.clear();
}

// ============================================================
// GetPrompt 接口：返回到期任务提醒
// ============================================================

/**
 * 获取当前到期的任务描述（供 getPromptHandler 注入）
 * @returns {string} 到期任务文本，空串表示无到期
 */
export function getDueJobsText(username, charName) {
  const key = `${username}/${charName}`;
  const state = _schedulerState.get(key);
  if (!state) return "";

  const now = Date.now();
  const dueJobs = state.jobs.filter((j) => {
    if (!j.enabled) return false;
    if (!j.nextRunAt) return false;
    return new Date(j.nextRunAt).getTime() <= now;
  });

  if (dueJobs.length === 0) return "";

  return dueJobs
    .map((j) => `【定时任务到期】${j.name}: ${j.description}`)
    .join("\n\n");
}

/**
 * 获取所有启用任务的摘要（供 {{scheduler_jobs_summary}} 宏）
 */
export function getJobsSummary(username, charName) {
  const key = `${username}/${charName}`;
  const state = _schedulerState.get(key);
  if (!state || state.jobs.length === 0) return "(暂无定时任务)";

  const enabled = state.jobs.filter((j) => j.enabled);
  if (enabled.length === 0) return "(暂无启用的定时任务)";

  return enabled
    .map(
      (j) =>
        `- [${j.schedule.type}] ${j.name}: ${j.description} (下次: ${j.nextRunAt || "计算中"})`,
    )
    .join("\n");
}

// ============================================================
// ReplyHandler 接口：解析 <scheduleTask> 标签
// ============================================================

/**
 * 解析 AI 回复中的 <scheduleTask> 标签，创建任务
 * @param {string} content - AI 回复内容
 * @param {string} username
 * @param {string} charName
 * @returns {{ found: boolean, cleanedContent: string }} 是否找到标签 + 清理后的内容
 */
export function parseScheduleTaskTag(content, username, charName, chatid = null) {
  wbT(chatid, "scheduler", "parseScheduleTaskTag:enter", { username, charName });
  const match = content.match(
    /<scheduleTask>([\s\S]*?)<\/scheduleTask>/i,
  );
  if (!match) return { found: false, cleanedContent: content };

  try {
    const jobDef = JSON.parse(match[1]);
    wbT(chatid, "scheduler", "parseScheduleTaskTag:addJob", { jobName: jobDef.name, type: jobDef.schedule?.type });
    const _addResult = addJob(username, charName, {
      ...jobDef,
      chatid: jobDef.chatid || chatid,
      createdBy: "ai",
    });
    if (_addResult?.success === false) {
      // 标签下面会被清理且返回 found:true，若不报会静默丢任务（如调度器未启动）
      wbD(chatid, "scheduler", "parseScheduleTaskTag:addJob", false, _addResult.error, { jobName: jobDef.name });
      console.warn(
        `[beilu-scheduler] AI定时任务未创建: ${_addResult.error}（标签已清理但任务丢失）`,
      );
    } else {
      console.log(
        `[beilu-scheduler] AI创建定时任务: ${jobDef.name || "未命名"}`,
      );
    }
  } catch (e) {
    wbD(chatid, "scheduler", "parseScheduleTaskTag:parseError", false, e.message, {});
    console.warn("[beilu-scheduler] 解析 scheduleTask 标签失败:", e.message);
  }

  const cleanedContent = content.replace(
    /<scheduleTask>[\s\S]*?<\/scheduleTask>/gi,
    "",
  );
  return { found: true, cleanedContent };
}

// ============================================================
// SetData 接口：CRUD
// ============================================================

export function addJob(username, charName, jobDef) {
  const key = `${username}/${charName}`;
  wbT(null, "scheduler", "addJob:enter", { key, jobName: jobDef.name, scheduleType: jobDef.schedule?.type });
  const state = _schedulerState.get(key);
  if (!state) { wbD(null, "scheduler", "addJob:noScheduler", false, "调度器未启动", { key }); return { success: false, error: "调度器未启动" }; }

  const job = {
    id: `job_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    name: jobDef.name || "未命名任务",
    description: jobDef.description || "",
    schedule: jobDef.schedule || { type: "once", runAt: new Date().toISOString() },
    action: jobDef.action || { type: "inject" },
    chatid: jobDef.chatid || jobDef.action?.target?.chatid || null, // ★ 激活目标会话（auto_reply/wake 用），inject 不需要
    enabled: jobDef.enabled ?? true,
    lastRunAt: null,
    lastRunResult: null,
    nextRunAt: null,
    runCount: 0,
    createdAt: new Date().toISOString(),
    createdBy: jobDef.createdBy || "user",
    tags: jobDef.tags || [],
  };
  job.nextRunAt = _calcNextRun(job);

  state.jobs.push(job);
  wbT(null, "scheduler", "addJob:saved", { jobId: job.id, nextRunAt: job.nextRunAt });
  _saveJobs(state.username, state.charName, state.jobs);
  return { success: true, job };
}

export function removeJob(username, charName, jobId) {
  const state = _schedulerState.get(`${username}/${charName}`);
  if (!state) return { success: false, error: "调度器未启动" };

  const idx = state.jobs.findIndex((j) => j.id === jobId);
  if (idx === -1) return { success: false, error: "任务不存在" };

  state.jobs.splice(idx, 1);
  _saveJobs(state.username, state.charName, state.jobs);
  return { success: true };
}

export function updateJob(username, charName, jobId, updates) {
  const state = _schedulerState.get(`${username}/${charName}`);
  if (!state) return { success: false, error: "调度器未启动" };

  const job = state.jobs.find((j) => j.id === jobId);
  if (!job) return { success: false, error: "任务不存在" };

  Object.assign(job, updates);
  if (updates.schedule) job.nextRunAt = _calcNextRun(job);
  _saveJobs(state.username, state.charName, state.jobs);
  return { success: true, job };
}

export function toggleJob(username, charName, jobId, enabled) {
  const state = _schedulerState.get(`${username}/${charName}`);
  if (!state) return { success: false, error: "调度器未启动" };

  const job = state.jobs.find((j) => j.id === jobId);
  if (!job) return { success: false, error: "任务不存在" };

  job.enabled = enabled;
  _saveJobs(state.username, state.charName, state.jobs);
  return { success: true };
}

export function listJobs(username, charName) {
  const state = _schedulerState.get(`${username}/${charName}`);
  if (!state) {
    // 读写同源（2026-07-16 断链修）：任务由 _saveJobs 持久落盘（work_config.scheduled_tasks），
    //   原「未启动返回空表 success:true」让后端重启后 UI 恒显「无定时任务」——用户建过的任务
    //   隐身（写盘读内存不同源，每个函数各自正确、链断）。未启动改读盘只读投影，并回传
    //   running:false 供前端如实显示调度器状态。盘文件损坏由 _loadJobs 抛错（T019 口径）上层可见。
    return { success: true, jobs: _loadJobs(username, charName), running: false };
  }
  return { success: true, jobs: state.jobs, running: true };
}

// ============================================================
// 代码轮次触发源（v3 §2：第三条触发轴 = rounds，与 cron/interval/once 的时间轴并列）
//
// 由 beilu-chat generation.mjs 的 auto-continue 循环每轮调用，复用其 _autoContinueCounters
// 作为"代码轮次"计数 → 命中已注册的 code_round job 即经统一入口 dispatchActivation 激活目标。
// 机制不写策略：触发哪个目标、每几轮，全由 producer 侧的 job 决定（scheduler_addJob / <scheduleTask>）。
// ============================================================

/**
 * 检查并触发"代码轮次"型激活 job（schedule.type === "code_round"）。
 * job.schedule: { type:"code_round", everyRounds?:N(周期), atRound?:N(一次性) }。
 * @param {string} username
 * @param {string} charName
 * @param {string} sourceChatid - 正在跑 code 轮次的源会话；job 按此绑定计数
 * @param {number} roundCount   - 当前轮次（1-based，= _autoContinueCounters 计数）
 */
export function runCodeRoundTriggers(username, charName, sourceChatid, roundCount) {
  if (!sourceChatid || !(roundCount > 0)) return;
  // 轮次触发授权=ModeDef 声明（codeRoundTriggers）。代码轮天然发生在 code 语境，此门=声明表诚实化（行为等价）。
  if (!schedulerFeature(getActiveMode(username, charName, sourceChatid)).codeRoundTriggers) return;
  const key = `${username}/${charName}`;
  let state = _schedulerState.get(key);
  // 自举：scheduler 仅在 work 模式/显式 start 时启动，但代码轮次发生在 IDE/code 模式。
  // 若未启动则在此惰性启动，否则 code_round 触发器会因 registry 为空而静默失效（死功能）。
  if (!state) {
    try {
      startScheduler(username, charName, getMemoryDir(username, charName));
      state = _schedulerState.get(key);
    } catch (e) {
      console.warn(`[beilu-scheduler] runCodeRoundTriggers 自举失败: ${e.message}`);
      return;
    }
  }
  if (!state) return;

  let changed = false;
  for (const job of state.jobs) {
    if (!job.enabled) continue;
    if (job.schedule?.type !== "code_round") continue;
    // 按"源会话"绑定：只数注册时所在会话（job.chatid）的轮次；未绑定则对任意源会话生效。
    const _bound = job.chatid || job.action?.target?.chatid || null;
    if (_bound && _bound !== sourceChatid) continue;

    const _at = Number(job.schedule.atRound) || 0;
    const _every = Number(job.schedule.everyRounds) || 0;
    const _hit = _at > 0 ? roundCount === _at : _every > 0 && roundCount % _every === 0;
    if (!_hit) continue;

    // 生成型动作经统一激活入口；inject/table_update 由 GetPrompt 处理，这里不重复触发。
    // [0724] message 同属生成型(dispatchActivation 落用户位消息+触发生成),与 _tick 修复同批补路由。
    if (job.action?.type === "auto_reply" || job.action?.type === "wake" || job.action?.type === "message") {
      const _target = job.action?.target?.chatid || job.chatid || sourceChatid;
      _busActivate({ // 搭线：经 dispatch → bus:activate 出口节点（同一 dispatchActivation 实现）
        source: "code_round",
        action: { ...job.action, target: { ...(job.action.target || {}), chatid: _target } },
        chatid: job.chatid || sourceChatid,
        charname: charName,
      })
        .then((r) => {
          if (r?.ok === false) console.warn(`[beilu-scheduler] code_round bus:activate 失败: ${r.error?.msg}`);
        })
        .catch((e) =>
          console.warn(`[beilu-scheduler] code_round bus:activate 失败: ${e.message}`),
        );
      job.lastRunResult = "triggered";
    } else {
      job.lastRunResult = "skipped_non_generative";
    }
    job.lastRunAt = new Date().toISOString();
    job.runCount = (job.runCount || 0) + 1;
    if (_at > 0) job.enabled = false; // atRound 一次性触发：命中后禁用
    changed = true;
  }
  if (changed) _saveJobs(state.username, state.charName, state.jobs);
}

// ============================================================
// 内部：轮询引擎
// ============================================================

function _tick(key, memDir) {
  const state = _schedulerState.get(key);
  if (!state) return;

  const now = Date.now();
  let changed = false;

  for (const job of state.jobs) {
    if (!job.enabled) continue;
    if (job.schedule?.type === "code_round") continue; // 轮次驱动，由 runCodeRoundTriggers 触发，不走时间轮询
    if (!job.nextRunAt) {
      job.nextRunAt = _calcNextRun(job);
      changed = true;
      continue;
    }
    if (new Date(job.nextRunAt).getTime() > now) continue;

    // 到期！执行
    console.log(`[beilu-scheduler] 任务到期: ${job.name} (${job.id})`);
    wbT(job.chatid || null, "scheduler", "_tick:jobDue", { jobId: job.id, jobName: job.name, actionType: job.action?.type });

    // [0724 定时loop断链修] "message" 必须与 auto_reply/wake 同路由：原缺此型→带内容的「定时继续」
    //   （setDataActions setScheduledContinue: 有 content 即建 message 型 job）落入下方 else 只标
    //   lastRunResult="success" 从不派发=静默假成功（002「定时loop完全没有用」实证）。
    //   dispatchActivation 本就支持 message(落用户位消息+触发生成)；让路/节流/模式门对三型同语义。
    if (job.action?.type === "auto_reply" || job.action?.type === "wake" || job.action?.type === "message") {
      const _target = job.action?.target?.chatid || job.chatid || null;
      if (_target) {
        const _lastUserMsg = globalThis.__beiluLastUserMessage?.[_target] || 0;
        if (Date.now() - _lastUserMsg < 30000) {
          wbT(_target, "scheduler", "_tick:yieldToUser", { jobId: job.id, jobName: job.name, sinceLast: Date.now() - _lastUserMsg });
          continue;
        }
        globalThis.__beiluAutoSendCount = globalThis.__beiluAutoSendCount || {};
        const _asc = globalThis.__beiluAutoSendCount[_target] || 0;
        // 节流可配：advanced_limits.scheduler_pacing=false 时跳过概率节流
        let _pacingOn = true;
        try { _pacingOn = readJsonSafeSync(getYonbanConfigPath(state.username))?.advanced_limits?.scheduler_pacing !== false; } catch { /* 读失败=默认开 */ }
        if (_pacingOn && _asc > 0 && Math.random() > 1 / (1 + 2.5 * _asc)) {
          wbT(_target, "scheduler", "_tick:pacingSuppressed", { jobId: job.id, consecutiveCount: _asc });
          continue;
        }
        const _curMode = getActiveMode(state.username, state.charName, job.chatid);
        if (!schedulerFeature(_curMode).crossWindowWake) { // 到期激活授权=ModeDef 声明（crossWindowWake），零硬编码模式名
          wbT(_target, "scheduler", "_tick:modeGate", { jobId: job.id, mode: _curMode });
          continue;
        }
        globalThis.__beiluAutoSendCount[_target] = _asc + 1;
        wbT(_target, "scheduler", "_tick:dispatchActivation", { jobId: job.id, target: _target });
        _busActivate({ // 搭线：经 dispatch → bus:activate 出口节点（同一 dispatchActivation 实现）
          source: "user_schedule",
          action: job.action,
          chatid: job.chatid,
          charname: state.charName,
        })
          .then((r) => {
            if (r?.ok === false) {
              wbD(_target, "scheduler", "_tick:dispatchActivation", false, r.error?.msg, { jobId: job.id });
              console.warn(`[beilu-scheduler] bus:activate 失败: ${r.error?.msg}`);
            }
          })
          .catch((e) => {
            wbD(_target, "scheduler", "_tick:dispatchActivation", false, e.message, { jobId: job.id });
            console.warn(`[beilu-scheduler] bus:activate 失败: ${e.message}`);
          });
        job.lastRunResult = "triggered";
      } else {
        wbD(null, "scheduler", "_tick:skipped_no_chatid", false, "no chatid", { jobId: job.id });
        job.lastRunResult = "skipped_no_chatid";
      }
    } else {
      // inject / table_update：到期后由 GetPrompt 注入，这里只标记
      job.lastRunResult = "success";
    }

    job.lastRunAt = new Date().toISOString();
    job.runCount = (job.runCount || 0) + 1;

    // 一次性任务执行后禁用
    if (job.schedule.type === "once") {
      job.enabled = false;
    }

    // 重算下次执行时间
    job.nextRunAt = _calcNextRun(job);
    changed = true;
  }

  if (changed) _saveJobs(state.username, state.charName, state.jobs);
}

// ============================================================
// 内部：调度计算
// ============================================================

function _calcNextRun(job) {
  const now = new Date();
  switch (job.schedule?.type) {
    case "interval": {
      const ms = job.schedule.intervalMs || (job.schedule.intervalMinutes ? job.schedule.intervalMinutes * 60000 : 3600000);
      const base = job.lastRunAt ? new Date(job.lastRunAt) : now;
      return new Date(base.getTime() + ms).toISOString();
    }
    case "once":
      return job.schedule.runAt || null;
    case "cron":
      return _parseCronNext(job.schedule.cron, now);
    default:
      return null;
  }
}

/**
 * 简易 cron 解析（支持 "分 时 日 月 星期" 格式）
 * 从当前时间向后逐分钟推进，最多推24小时
 */
function _parseCronNext(cronExpr, fromDate) {
  if (!cronExpr) return null;
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const [minExpr, hourExpr, dayExpr, monExpr, dowExpr] = parts;

  const matchField = (expr, value, max) => {
    if (expr === "*") return true;
    // 支持逗号分隔: "1,3,5"
    const vals = expr.split(",");
    for (const v of vals) {
      if (v.includes("-")) {
        // 范围: "1-5" 或 "MON-FRI"
        const [a, b] = v.split("-").map((s) => _parseDow(s, max));
        if (value >= a && value <= b) return true;
      } else if (v.includes("/")) {
        // 步进: "*/5"
        const step = parseInt(v.split("/")[1]);
        if (!isNaN(step) && value % step === 0) return true;
      } else {
        const n = _parseDow(v, max);
        if (value === n) return true;
      }
    }
    return false;
  };

  // 从下一分钟开始，最多推24*60=1440次
  const cursor = new Date(fromDate);
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);

  for (let i = 0; i < 1440; i++) {
    const m = cursor.getMinutes();
    const h = cursor.getHours();
    const d = cursor.getDate();
    const mon = cursor.getMonth() + 1;
    const dow = cursor.getDay(); // 0=Sun

    if (
      matchField(minExpr, m, 59) &&
      matchField(hourExpr, h, 23) &&
      matchField(dayExpr, d, 31) &&
      matchField(monExpr, mon, 12) &&
      matchField(dowExpr, dow, 7)
    ) {
      return cursor.toISOString();
    }
    cursor.setMinutes(cursor.getMinutes() + 1);
  }

  // 24小时内未找到匹配，返回null
  console.warn(`[beilu-scheduler] cron "${cronExpr}" 24小时内无匹配`);
  return null;
}

function _parseDow(s, _max) {
  const dowMap = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };
  const upper = s.toUpperCase();
  if (dowMap[upper] !== undefined) return dowMap[upper];
  const n = parseInt(s);
  return isNaN(n) ? 0 : n;
}

// ============================================================
// 内部：持久化
// ============================================================

function _loadJobs(username, charName) { // T7 尾段收口：签名 memDir→(username,charName)，路径引权威 getWorkConfigPath
  // 0716 T019 差集收编：损坏 → readJsonSafeSync 备份 .corrupt.bak 后抛 CorruptJsonError（原静默返 []，
  //   若随后 _saveJobs 会以空表写回=定时任务整表覆盖销毁）。抛错由调用点既有 try/catch 承接
  //   （恢复循环 resumeAllSchedulers warn 跳过该卡，其余入口上层 REST/action 报错可见）。
  const config = readJsonSafeSync(getWorkConfigPath(username, charName), {});
  return config.scheduled_tasks || [];
}

function _saveJobs(username, charName, jobs) { // T7 尾段收口：同上
  const configPath = getWorkConfigPath(username, charName);
  // [0722 锁收口] RMW 经 withFileLock 排队（与流程组五case/W61/selected_groups 同锁键=同一 config 路径）——
  //   原无锁直写会插进对方 load→save 的 await 窗口互覆字段（如 selected_groups 被本快照写回旧值抹掉）。
  //   签名保持同步（内存 state.jobs 是权威、本函数只做快照落盘：fire-and-forget 经锁链 FIFO 保序，
  //   后到的写恒写 live 数组最新态=收敛正确；调用方含 sync 的 _tick/导出 CRUD，不强 async 化涟漪全链）。
  // 0716 T019 差集收编：读回损坏 → 抛（原 catch{} 静默 config={} → 写回把 work_config 其余字段全部销毁）；
  //   锁化后损坏错误降为 warn 日志可见（不再同步上抛调用方），"不销毁"核心语义保留。
  withFileLock(configPath, async () => {
    const config = readJsonSafeSync(configPath, {});
    config.scheduled_tasks = jobs;
    saveJsonFile(configPath, config);
  }).catch((e) => {
    console.warn(`[beilu-scheduler] _saveJobs 落盘失败(内存态仍权威,下次任一写点会重带最新快照): ${e.message}`);
  });
}

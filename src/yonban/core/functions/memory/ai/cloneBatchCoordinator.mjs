// cloneBatchCoordinator.mjs — 正式分身批次从去重、派发到持久化投递的唯一生命周期 owner。

import path from "node:path";
import { pathToFileURL } from "node:url";
import { wbT } from "../../../../../server/wbStub.mjs";
import {
  __projectRoot,
  diag,
  getYonbanConfigPath,
  readJsonFileSnapshotStrict,
  loadMemoryData,
  markCloneResultDelivery,
  projectCloneRuntimeEvent,
  readCloneResult,
  saveCloneLongResult,
  saveCloneResult,
} from "../storage_mod/storage.mjs";
import { dispatch } from "../../../dispatch/dispatcher.mjs";
import { ideClient } from "../../../transport/ideClient.mjs";
import { stripReasoningTags } from "../../api/proxy/lib/messageTransform.mjs";
import { registerCloneAbort, unregisterCloneAbort } from "../handler/cloneAbort.mjs";
import { createCloneStatusEvent, createDefaultCloneConfigs, normalizeCloneConfigs, resolveCloneConfig, resolveCloneMaxWorkRounds } from "./cloneContract.mjs";
import { runCloneTask } from "./cloneTaskRunner.mjs";

function cloneParentGenerationId(chatLog) {
  return (chatLog || []).findLast((item) => item?.role === "user" && typeof item.id === "string" && item.id.trim())?.id.trim() || null;
}

function readCloneConfigSnapshot(username) {
  const configPath = getYonbanConfigPath(username);
  const snapshot = readJsonFileSnapshotStrict(configPath, {});
  const config = snapshot.value;
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("分身配置根节点必须是对象");
  const rawClones = config.clones === undefined ? createDefaultCloneConfigs() : config.clones;
  return { ...config, clones: normalizeCloneConfigs(rawClones), revision: snapshot.revision };
}

function priorCloneTasksForParent(chatLog, parentGenerationId) {
  const tasks = new Map();
  if (!parentGenerationId) return tasks;
  for (const entry of chatLog || []) {
    const extension = entry?.extension || {};
    const aggregates = [extension._cloneAggregate, ...(Array.isArray(extension._cloneAggregates) ? extension._cloneAggregates : [])].filter(Boolean);
    for (const aggregate of aggregates) {
      if (String(aggregate?.parentGenerationId || "") !== parentGenerationId) continue;
      for (const task of aggregate?.tasks || []) {
        if (task?.state === "terminal" && task?.job?.taskId !== undefined) tasks.set(String(task.job.taskId), task);
      }
    }
  }
  return tasks;
}

function normalizeCloneBatchResults(rawResults, tasks, jobs, defaultLabel) {
  return (tasks || []).map((task, index) => {
    const job = jobs?.[index];
    const raw = rawResults?.[index];
    const terminal = {
      id: task.id, label: task.cloneName || defaultLabel || "默认分身", job,
      state: "terminal", completion: "none", success: false, resumable: false,
      rounds: 0, logicalCalls: 0, totalTools: 0,
    };
    const persisted = {
      runtimeSnapshot: false,
      resumeSnapshot: raw?.persisted?.resumeSnapshot === true,
      resultStored: false,
      resultId: null,
      deliveryEnqueued: false,
      userVisible: false,
    };
    if (!raw) return { ...terminal, status: "not_started", terminalReason: "parent_aborted", reply: "", error: "父生成在任务取得执行槽前已中止", persisted };
    if (raw._uncaught) return {
      ...raw, ...terminal, status: "error", terminalReason: "exception", persisted,
    };
    return { ...raw, job: raw.job || job, state: raw.state || "terminal", persisted: { ...persisted, ...(raw.persisted || {}) } };
  });
}

function attachedResultView(aggregate) {
  return aggregate.tasks.map(({ output, error, taskType, rounds, logicalCalls, toolCount, configRevision, ...task }) => ({
    ...task,
    preview: (output || error || "").substring(0, 100),
  }));
}

/**
 * 正式分身批次唯一入口。调用者只提供请求上下文与既有通用并发/记账函数，
 * 不再自行持有 job、controller、终态聚合、持久化、投递或唤醒状态。
 */
export async function coordinateCloneBatch({
  tasks = [],
  username,
  charName,
  chatId = "",
  queueChatId,
  chatLog = [],
  charDisplayName = "",
  generationArgs = {},
  admit = () => true,
  createBatchId,
  runWithConcurrency,
  opLog = () => {},
} = {}) {
  if (!Array.isArray(tasks) || tasks.length === 0) return {};
  if (typeof createBatchId !== "function" || typeof runWithConcurrency !== "function") {
    throw new Error("分身批次缺少 ID 或并发执行契约");
  }

  const parentGenerationId = cloneParentGenerationId(chatLog);
  const priorTasks = priorCloneTasksForParent(chatLog, parentGenerationId);
  const seenTaskIds = new Set();
  const suppressed = [];
  const runnableTasks = tasks.filter((task) => {
    const taskKey = String(task.id);
    const prior = priorTasks.get(taskKey);
    const repeatedInBatch = seenTaskIds.has(taskKey);
    seenTaskIds.add(taskKey);
    if (!task.resumeTaskId && (prior || repeatedInBatch)) {
      suppressed.push({ task, prior: prior || null, reason: prior ? "parent_task_terminal" : "duplicate_in_batch" });
      return false;
    }
    return true;
  });
  const duplicateSuppressed = suppressed.map(({ task, prior, reason }) => ({
    parentGenerationId,
    taskId: task.id,
    jobId: prior?.job?.jobId || null,
    reason,
  }));
  if (suppressed.length > 0) {
    diag.warn(`分身系统: 同一父代抑制${suppressed.length}个重复任务 (${suppressed.map((item) => `#${item.task.id}`).join(", ")})`);
  }
  if (runnableTasks.length === 0) {
    const priorText = suppressed.map((item) => item.prior?.output || item.prior?.error || "").filter(Boolean).join("\n\n");
    return {
      duplicateSuppressed,
      contentAppend: `\n${priorText || `[分身任务已在当前父生成中处理，未重复执行：${suppressed.map((item) => `#${item.task.id}`).join(", ")}]`}`,
      stopContinue: true,
    };
  }
  // 配置拒绝必须发生在 admit/controller/queued 之前；否则 Runner 入口抛错时会留下孤儿运行态。
  const config = readCloneConfigSnapshot(username);
  const selectedClones = runnableTasks.map((task) => {
    if (typeof task?.instruction !== "string" || !task.instruction.trim()) throw new Error(`分身任务 #${task?.id ?? "?"} 缺少 instruction`);
    const selected = resolveCloneConfig(config, task, undefined, { requireEnabled: true });
    resolveCloneMaxWorkRounds(selected.maxRounds);
    return selected;
  });
  const defaultClone = config.clones.find((clone) => clone.enabled);
  if (!admit("clone", `×${runnableTasks.length}`)) {
    return { duplicateSuppressed, admitted: false };
  }
  const asyncMode = config.clone_async?.enabled === true;
  const cloneBatchId = createBatchId("clone_batch");
  const jobs = runnableTasks.map((task) => ({
    ownerUsername: username,
    chatId,
    parentGenerationId,
    cloneBatchId,
    taskId: task.id,
    jobId: `${cloneBatchId}:${task.id}`,
    source: "subagent",
    sourceDetail: "formal",
    executionMode: asyncMode ? "detached" : "attached",
  }));
  const abortControllers = jobs.map((job) => registerCloneAbort(
    username,
    chatId,
    job.taskId,
    job,
    { detached: asyncMode },
  ));
  const snapshotWrites = new Map();
  const emitStatus = (event) => {
    const runtimeSnapshot = projectCloneRuntimeEvent(username, charName, chatId, event);
    snapshotWrites.set(event.jobId, runtimeSnapshot);
    if (chatId) {
      dispatch({ target: "bus:broadcast", verb: "emit", source: "yonban", payload: { chatid: chatId, event: {
        type: "clone_status",
        payload: event,
      } } }).catch(() => {});
    }
    return { runtimeSnapshot };
  };
  jobs.forEach((job, index) => emitStatus(createCloneStatusEvent(job, {
    sequence: 0,
    round: 0,
    status: "batch_queued",
    detail: "任务已进入批内派发队列",
    label: `${selectedClones[index].label}#${runnableTasks[index].id}`,
  })));
  const thunks = runnableTasks.map((task, index) => () => runCloneTask({
    username,
    charName,
    chatId,
    task,
    configSnapshot: config,
    chatLog,
    charDisplayName,
    generationArgs,
    parentSignal: generationArgs?.generation_options?.signal,
    detached: asyncMode,
    sourceDetail: "formal",
    jobIdentity: jobs[index],
    abortController: abortControllers[index],
    emitStatus,
  }));
  const concurrency = loadMemoryData(username, charName)?.config?.clone_concurrency ?? 0;
  let finishPromise = null;
  const finish = (rawResults) => {
    if (finishPromise) return finishPromise;
    finishPromise = (async () => {
      // 并发池遇父 signal 中止时不会调用尚未取槽的 thunk；这些 job 已预注册并投影 queued，
      // 必须由批 owner 补唯一 stopped 终态并按 controller 身份注销，不能留 active/queued 孤儿。
      for (let index = 0; index < jobs.length; index++) {
        if (rawResults?.[index] !== undefined) continue;
        try {
          emitStatus(createCloneStatusEvent(jobs[index], {
            sequence: 1,
            round: 0,
            status: "stopped",
            detail: "父生成在任务取得执行槽前已中止",
            label: selectedClones[index].label,
            terminalReason: "parent_aborted",
            completion: "none",
            resultStatus: "not_started",
            resumable: false,
          }));
        } finally {
          unregisterCloneAbort(username, chatId, runnableTasks[index].id, abortControllers[index]);
        }
      }
      const results = normalizeCloneBatchResults(rawResults, runnableTasks, jobs, defaultClone.label);
      diag.log(`分身执行完成: ${results.length}个任务, 结果: ${results.map((result) => `#${result.id}=${result.status}(${(result.reply || result.error || "").length}字符)`).join(", ")}`);
      for (const result of results) {
        opLog("clone", `#${result.id} ${result.label}`, { status: result.status, terminalReason: result.terminalReason, completion: result.completion, rounds: result.rounds, logicalCalls: result.logicalCalls, tools: result.totalTools, replyLen: (result.reply || result.error || "").length }, result.success === true ? "ok" : "fail");
      }
      wbT(chatId, "memory", "handleReply:cloneAggregate", { count: results.length, incomplete: results.filter((result) => result.success !== true).length });
      let aggregate = {
        version: 1,
        parentGenerationId,
        cloneBatchId,
        state: "terminal",
        status: results.every((result) => result.success === true) ? "completed" : results.some((result) => result.completion !== "none") ? "partial" : "error",
        completion: results.every((result) => result.completion === "complete") ? "complete" : results.some((result) => result.completion !== "none") ? "partial" : "none",
        success: results.every((result) => result.success === true),
        tasks: results.map((result) => ({
          id: result.id,
          label: result.label,
          taskType: result.taskType ?? null,
          job: result.job,
          state: result.state,
          status: result.status,
          terminalReason: result.terminalReason,
          completion: result.completion,
          completionEvidence: result.completionEvidence || null,
          success: result.success === true,
          resumable: result.resumable === true,
          rounds: result.rounds ?? 0,
          logicalCalls: result.logicalCalls ?? 0,
          toolCount: result.totalTools ?? 0,
          output: result.reply || "",
          error: result.error || null,
          persisted: { ...(result.persisted || {}), runtimeSnapshot: snapshotWrites.get(result.job?.jobId) === true },
          configRevision: result.configRevision ?? null,
        })),
      };
      const resultText = await Promise.all(results.map(async (result) => {
        const resumeHint = result.resumable ? `\n↩ 非自然结束(${result.terminalReason})——上下文已存，可派分身带 resumeTaskId=${result.id} resumeJobId="${result.job?.jobId || ""}" 从中断处续接（复制上下文继续，不重头来）。` : "";
        const resultLabel = result.success === true ? "完成" : result.completion === "partial" ? "部分完成" : "未完成";
        const header = `--- 分身任务#${result.id} (${result.label}) ${resultLabel} [${result.terminalReason || result.status}] (${result.rounds ?? 0}轮/${result.totalTools || 0}次工具) ---`;
        if (result.status === "error") return `${header}\n❌ ${result.error || result.reply || "(无输出)"}${resumeHint}`;
        const full = stripReasoningTags(result.reply || "", username).replace(/\n{3,}/g, "\n\n").trim() || "(无输出)";
        const completionProof = result.completionEvidence ? `\n完成证据: ${result.completionEvidence}` : "";
        if (full.length <= 3000) return `${header}\n${full}${completionProof}${resumeHint}`;
        let savedPath = "";
        try {
          savedPath = saveCloneLongResult(username, charName, result.id, result.label, full);
        } catch (error) {
          diag.error(`分身结果存文件失败: ${error.message}`);
        }
        const fileRef = savedPath ? `\n📄 完整结果已存入: ${savedPath}（用read_file读取）` : "";
        return `${header}\n${full.substring(0, 1500)}\n... (省略${full.length - 2000}字符) ...${fileRef}\n${full.substring(full.length - 500)}${completionProof}${resumeHint}`;
      })).then((parts) => parts.join("\n\n"));
      const failedCount = results.filter((result) => result.success !== true).length;
      let reminder = "";
      if (asyncMode) {
        try {
          const injectTexts = await import("../../injectTexts/main.mjs");
          reminder = injectTexts.fillInjectText(injectTexts.getInjectText("clone.async_done_reminder", username), { count: String(results.length), failed: String(failedCount) }) + "\n\n";
        } catch (error) {
          diag.warn(`分身异步完成提醒文本读取失败(跳过提醒头): ${error.message}`);
        }
      }
      const deliveryText = `${reminder}[分身AI执行结果 — ${results.length}个任务]\n\n${resultText}\n\n[/分身AI执行结果]`;
      const storedResult = saveCloneResult(username, charName, queueChatId, aggregate, { text: deliveryText });
      const storedReadback = readCloneResult(username, charName, queueChatId, cloneBatchId);
      if (!storedResult?.verified || !storedReadback || storedReadback.resultHash !== storedResult.resultHash) {
        throw new Error(`分身聚合结果持久化读回失败: parent=${parentGenerationId || "none"}, batch=${cloneBatchId}`);
      }
      aggregate = {
        ...storedReadback.result,
        tasks: storedReadback.result.tasks.map((task) => ({
          ...task,
          persisted: { ...task.persisted, resultHash: storedResult.resultHash, deliveryEnqueued: false, userVisible: false },
        })),
        resultRef: {
          resultId: storedResult.resultId,
          resultHash: storedResult.resultHash,
          savedAt: storedResult.savedAt,
          expiresAt: storedResult.expiresAt,
        },
      };
      const deliveryAggregate = {
        ...aggregate,
        tasks: aggregate.tasks.map((task) => ({ ...task, persisted: { ...task.persisted, deliveryEnqueued: true } })),
      };
      const enqueued = ideClient.enqueuePendingResult({
        tool: "_clone_results",
        params: { parentGenerationId, cloneBatchId, resultId: storedResult.resultId, resultHash: storedResult.resultHash, charName, taskCount: results.length, failedCount, async: asyncMode },
        result: { success: deliveryAggregate.success, error: failedCount > 0 ? `${failedCount}/${results.length} 个分身任务未完成（详情见 terminalReason/completion）` : undefined, result: deliveryText, cloneAggregate: deliveryAggregate },
        chatid: queueChatId,
        ownerUsername: username,
        timestamp: new Date().toISOString(),
      });
      if (!enqueued) throw new Error(`分身聚合结果入队失败: parent=${parentGenerationId || "none"}, batch=${cloneBatchId}`);
      const deliveryReadback = markCloneResultDelivery(username, charName, queueChatId, cloneBatchId, { enqueued: true });
      if (!deliveryReadback?.delivery?.enqueued) throw new Error(`分身结果投递状态落盘失败: batch=${cloneBatchId}`);
      aggregate = deliveryAggregate;
      let wakeState = { accepted: true, scheduled: false, pending: true, reason: asyncMode ? "not_notified" : "attached" };
      if (asyncMode) {
        try {
          const generationPath = path.join(__projectRoot, "src", "public", "parts", "shells", "beilu-chat", "src", "lib", "generation.mjs");
          const generation = await import(pathToFileURL(generationPath).href);
          const wakeChar = charName === "_global" ? (charDisplayName || undefined) : charName;
          wakeState = generation.notifyAsyncCloneDone?.(queueChatId, wakeChar, username, { resultId: storedResult.resultId, cloneBatchId }) || wakeState;
        } catch (error) {
          wakeState = { accepted: false, scheduled: false, pending: true, reason: "notify_failed" };
          diag.error(`分身异步唤醒失败（结果已持久化并入池，下次用户互动可见）: ${error.message}`);
        }
      }
      try {
        await dispatch({ target: "bus:broadcast", verb: "emit", source: "yonban", payload: { chatid: queueChatId, event: {
          type: "tool_results_ready",
          payload: {
            count: ideClient.getPendingResultCount({ ownerUsername: username, chatid: queueChatId }),
            source: "clone_results",
            background: asyncMode,
            readOnly: true,
            stopContinue: false,
            resultId: storedResult.resultId,
            resultHash: storedResult.resultHash,
            parentGenerationId,
            cloneBatchId,
            delivery: wakeState,
          },
        } } });
      } catch (error) {
        diag.warn(`分身结果已就绪广播失败（不影响持久化/下次消费）: ${error.message}`);
      }
      return { aggregate, resultId: storedResult.resultId, resultHash: storedResult.resultHash, wake: wakeState };
    })();
    return finishPromise;
  };

  if (asyncMode) {
    try {
      const injectTexts = await import("../../injectTexts/main.mjs");
      ideClient.enqueuePendingResult({
        tool: "_clone_results",
        params: { dispatched: thunks.length, async: true },
        result: { success: true, result: injectTexts.fillInjectText(injectTexts.getInjectText("clone.async_dispatched", username), { count: String(thunks.length) }) },
        chatid: queueChatId,
        ownerUsername: username,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      diag.warn(`分身异步派发提示注入失败(不影响派发): ${error.message}`);
    }
    runWithConcurrency(thunks, concurrency, undefined).then(async (results) => {
      try {
        await finish(results);
      } catch (error) {
        diag.error(`分身异步收尾失败: ${error.message}\n${error.stack || ""}`);
        try {
          ideClient.enqueuePendingResult({ tool: "_clone_results", params: { async: true }, result: { success: false, error: `分身异步收尾失败: ${error.message}` }, chatid: queueChatId, ownerUsername: username, timestamp: new Date().toISOString() });
        } catch {
          // 入队失败仅日志。
        }
      }
    });
    return { duplicateSuppressed };
  }

  const rawResults = await runWithConcurrency(thunks, concurrency, generationArgs?.generation_options?.signal);
  const completed = await finish(rawResults);
  return {
    duplicateSuppressed,
    aggregate: completed.aggregate,
    results: attachedResultView(completed.aggregate),
  };
}

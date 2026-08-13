// cloneTaskRunner.mjs — 正式分身与“分身测试”的唯一多轮执行正主。
// 入口只负责把用户动作翻译成 task/config/context；预设、权限、停止、工具和终态均在这里执行。

import crypto from "node:crypto";
import { wbD } from "../../../../../server/wbStub.mjs";
import { diag, getSystemText, loadCloneResumeSnapshot, loadMemoryData, loadMemoryPresets, resolveGenerationMode, saveCloneResumeSnapshot } from "../storage_mod/storage.mjs";
import { generateTableDataOnly } from "../storage_mod/tableEngine.mjs";
import { runMemoryPresetAI } from "./aiRunner.mjs";
import { cloneCapabilityDeniedMessage, resolveCloneCapability } from "./cloneAccess.mjs";
import { cloneTerminalShape, createCloneStatusEvent, inferCloneTaskType, isCloneTerminalEventStatus, parseCloneCompletion, resolveCloneConfig, resolveCloneMaxWorkRounds } from "./cloneContract.mjs";
import { resolvePresetForMemoryAI } from "./presetBridge.mjs";
import { registerCloneAbort, unregisterCloneAbort } from "../handler/cloneAbort.mjs";
import { executeWebSearch, buildInjectableSearchText } from "../../web/webSearch.mjs";
import { executeWebDownload } from "../../web/webDownload.mjs";
import { stripReasoningTags } from "../../api/proxy/lib/messageTransform.mjs";
import { ideClient, parseIdeToolCallTags, renderStaticIdeToolSignatures } from "../../../transport/ideClient.mjs";
function _safeTaskFileId(value) {
  return String(value ?? "unknown").replace(/[^\w.-]/g, "_").slice(0, 120) || "unknown";
}

async function _buildPromptRuntime({
  username,
  charName,
  chatId,
  task,
  clone,
  chatLog,
  charDisplayName,
  generationArgs,
}) {
  const memorySnapshot = loadMemoryData(username, charName, undefined, chatId);
  const presetsSnapshot = loadMemoryPresets(username, charName);
  const recentChat = [];
  if (Array.isArray(chatLog)) {
    const contextCount = clone.contextMessages;
    const start = Math.max(0, chatLog.length - contextCount);
    for (let index = start; index < chatLog.length; index++) {
      const message = chatLog[index];
      if (message?.role === "system" && message?.name === "IDE工具结果") continue;
      const maxChars = clone.maxContext >= 200000 ? 4000 : 800;
      recentChat.push(`<message role="${message?.role || "user"}" index="${index}">\n${String(message?.content || "").substring(0, maxChars)}\n</message>`);
    }
  }
  const contextText = recentChat.join("\n");

  let tableData = "";
  try {
    const displayUser = username || "_default";
    const displayChar = charName === "_global" ? (charDisplayName || charName) : charName;
    tableData = generateTableDataOnly(memorySnapshot.tables || [], displayChar, displayUser) || "";
  } catch (error) {
    diag.error(`分身tableData加载失败: ${error.message}`);
  }

  const resolvedPreset = resolvePresetForMemoryAI(username, clone.presetName, presetsSnapshot.presets);
  if (clone.presetName && !resolvedPreset) throw new Error(`分身预设不存在或无可用提示词: ${clone.presetName}`);
  const headPrompts = [];
  const tailPrompts = [];
  let prefill = "";
  for (const prompt of resolvedPreset?.prompts || []) {
    if (prompt.role === "assistant") {
      prefill = prompt.content;
    } else if (prompt.injection_depth === 0 || prompt.identifier === "clone_output_format" || prompt.identifier === "guide_avoid_mistakes") {
      tailPrompts.push(prompt.content);
    } else {
      headPrompts.push(prompt.content);
    }
  }

  let stripForContext = (text) =>
    stripReasoningTags(text || "", username).replace(/\n{3,}/g, "\n\n").trim();
  try {
    const { applyRegexRules, getRegexStore } = await import("../../regex/main.mjs");
    const regexData = getRegexStore(username);
    if (regexData?.enabled && regexData.rules?.length) {
      stripForContext = async (text) => {
        const result = await applyRegexRules(stripReasoningTags(text || "", username), regexData.rules, "reasoning", {});
        return result.replace(/\n{3,}/g, "\n\n").trim();
      };
    }
  } catch {
    // 用户正则不可用时仍保留内置 reasoning 剥离。
  }

  const injectionPrompts = presetsSnapshot.injection_prompts || [];
  let ideToolDoc = "";
  if (ideClient.isConnected) {
    const entry = injectionPrompts.find((item) => item.id === "INJ-2-code" && item.enabled);
    if (entry) {
      ideToolDoc = String(entry.content || "")
        .replace(/\{\{user\}\}/g, username)
        .replace(/\{\{env_tools\}\}/g, "")
        .replace(/\{\{ide_tools\}\}/g, renderStaticIdeToolSignatures())
        .replace(/<ide_extended>[\s\S]*?## 分身AI[\s\S]*?(?=##|<\/ide_extended>)/, "")
        .replace(/并行调用分身AI[\s\S]*?结果下一轮自动注入/g, "");
    }
  }

  const modeGroup = resolveGenerationMode(generationArgs || {}, username, charName, chatId);
  const webInjId = modeGroup === "work" ? "INJ-5-web-work" : "INJ-5-web-code";
  const webToolDoc = injectionPrompts.find((item) => item.id === webInjId && item.enabled)?.content || "";
  const prompts = [{ role: "system", content: headPrompts.join("\n\n"), enabled: true }];
  if (ideToolDoc) prompts.push({ role: "system", content: ideToolDoc, enabled: true });
  if (webToolDoc) prompts.push({ role: "system", content: webToolDoc, enabled: true });

  const pushDataInjection = (injId, values) => {
    const entry = injectionPrompts.find((item) => item.id === injId);
    if (!entry) {
      wbD(chatId, "clone", "dataInj:entryMissing", false, `分身数据注入条目缺失: ${injId}（恢复默认可找回）`, { injId });
      return;
    }
    if (entry.enabled === false) return;
    let content = String(entry.content || "");
    for (const [key, value] of Object.entries(values)) content = content.replaceAll(`{{${key}}}`, String(value ?? ""));
    if (content.trim()) prompts.push({ role: entry.role || "system", content, enabled: true });
  };
  if (tableData) pushDataInjection("INJ-clone-tables-data", { clone_tables: tableData });
  pushDataInjection("INJ-clone-context-data", {
    clone_context_count: recentChat.length,
    clone_context: contextText,
  });
  for (const content of tailPrompts) prompts.push({ role: "system", content, enabled: true });
  prompts.push({ role: "user", content: task.instruction, enabled: true });
  if (prefill) prompts.push({ role: "assistant", content: prefill, enabled: true });

  return {
    memorySnapshot,
    stripForContext,
    taskPreset: {
      id: `CLONE_${_safeTaskFileId(task.id)}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`,
      name: `${clone.label} #${task.id}`,
      prompts,
      api_config: {
        use_custom: !!(clone.apiSource || clone.modelName || clone.temperature !== undefined),
        source: clone.apiSource || undefined,
        model: clone.modelName || undefined,
        temperature: clone.temperature,
        max_tokens: clone.maxTokens,
        prompt_post_processing: clone.promptPostProcessing,
        prefill_enabled: clone.prefillEnabled,
        claude_prefill_mode: clone.claudePrefillMode,
        include_reasoning: clone.includeReasoning,
      },
    },
  };
}

export async function runCloneTask({
  username, charName, chatId = "", task, configSnapshot, cloneId,
  chatLog = [], charDisplayName = "", generationArgs = {}, parentSignal,
  detached = false, maxWorkRoundsOverride, sourceDetail = "formal",
  observe = false, emitStatus = () => {}, jobIdentity = null, abortController = null,
} = {}) {
  if (!username) throw new Error("分身执行缺少 username");
  if (!task || typeof task.instruction !== "string" || !task.instruction.trim()) throw new Error("分身执行缺少 instruction");
  const clone = resolveCloneConfig(configSnapshot, task, cloneId, { requireEnabled: sourceDetail !== "test" });
  const taskType = inferCloneTaskType(clone.label, task.instruction);
  const maxWorkRounds = resolveCloneMaxWorkRounds(clone.maxRounds, maxWorkRoundsOverride);
  const cloneBatchId = String(jobIdentity?.cloneBatchId || `standalone:${sourceDetail}:${task.id}`);
  let job = {
    ownerUsername: username,
    chatId: String(chatId || ""),
    parentGenerationId: jobIdentity?.parentGenerationId ? String(jobIdentity.parentGenerationId) : null,
    cloneBatchId,
    taskId: task.id,
    jobId: String(jobIdentity?.jobId || `${cloneBatchId}:${task.id}`),
    source: "subagent",
    sourceDetail,
    executionMode: detached ? "detached" : "attached",
  };
  let statusSequence = 0;
  const controller = abortController || registerCloneAbort(username, chatId, task.id, job, { detached });
  // controller registry 是执行宿主 owner；正式入口预注册和测试入口就地注册都从这里
  // 取回同一份已冻结 executionHost，Runner 不另造第二个宿主判定。
  job = controller?._cloneJob || job;
  const linkedSignal = detached ? undefined : parentSignal;
  let parentAborted = false;
  const onParentAbort = () => { parentAborted = true; controller.abort(); };
  if (linkedSignal) {
    if (linkedSignal.aborted) onParentAbort();
    else linkedSignal.addEventListener("abort", onParentAbort, { once: true });
  }
  let runtime = null;
  const messages = [];
  let finalReply = "";
  let totalTools = 0;
  let actualRounds = 0;
  let logicalCalls = 0;
  let terminalReason = "max_rounds";
  let completionEvidence = "";
  const roundDetails = [];
  const recentToolSignatures = [];
  let repeatWarnings = 0;
  let runtimeSnapshotSaved = false;
  const status = (round, state, detail, metadata = {}) => {
    try {
      const event = createCloneStatusEvent(job, {
        sequence: ++statusSequence,
        round,
        tools: totalTools,
        status: state,
        detail,
        label: clone.label,
        terminalReason: metadata.terminalReason ?? (isCloneTerminalEventStatus(state) ? terminalReason : null),
        completion: metadata.completion ?? null,
        resultStatus: metadata.resultStatus ?? null,
        resumable: metadata.resumable ?? null,
        ai: metadata.ai || null,
      });
      const projected = emitStatus(event);
      if (projected?.runtimeSnapshot === true) runtimeSnapshotSaved = true;
      return event;
    } catch (error) {
      diag.warn(`分身状态投影失败: ${error.message}`);
      return null;
    }
  };
  const resultBase = (resumeSnapshot = false) => ({
    id: task.id, label: clone.label, model: clone.modelName || "", apiSource: clone.apiSource || "",
    taskType, totalTools, rounds: actualRounds, logicalCalls, sourceDetail, maxWorkRounds, completionEvidence,
    job,
    configRevision: configSnapshot?.revision ?? configSnapshot?._revision ?? null,
    persisted: {
      runtimeSnapshot: runtimeSnapshotSaved,
      resumeSnapshot: resumeSnapshot === true,
      resultStored: false,
      resultId: null,
      deliveryEnqueued: false,
      userVisible: false,
    },
    ...(observe ? { roundDetails } : {}),
  });
  const finalizeResult = (result) => {
    const eventStatus = result?.status === "completed" ? "completed"
      : result?.status === "error" ? "error" : "stopped";
    status(result?.rounds ?? actualRounds, eventStatus, `终态: ${result?.terminalReason || terminalReason}`, {
      terminalReason: result?.terminalReason || terminalReason,
      completion: result?.completion || null,
      resultStatus: result?.status || null,
      resumable: result?.resumable === true,
    });
    return {
      ...result,
      persisted: { ...(result?.persisted || {}), runtimeSnapshot: runtimeSnapshotSaved },
    };
  };

  const saveResume = (reason) => {
    try {
      if (messages.length === 0) return false;
      saveCloneResumeSnapshot(username, {
        taskId: task.id,
        job,
        cloneId: clone.id,
        label: clone.label,
        terminalReason: reason,
        instruction: task.instruction,
        rounds: actualRounds,
        logicalCalls,
        totalTools,
        messages,
        savedAt: new Date().toISOString(),
      }, { keepDays: configSnapshot?.clone_resume_keep_days ?? 7 });
      return true;
    } catch (error) {
      diag.warn(`分身#${task.id} 续接上下文落盘失败: ${error.message}`);
      return false;
    }
  };

  try {
    if (controller.signal.aborted) {
      terminalReason = parentAborted ? "parent_aborted" : "user_aborted";
      return finalizeResult({ ...resultBase(false), reply: "(任务在批内排队阶段被中止，未启动 AI)", ...cloneTerminalShape(terminalReason, false, false) });
    }
    status(0, "accepted", task.instruction.substring(0, 80));
    runtime = await _buildPromptRuntime({
      username, charName, chatId, task, clone, chatLog, charDisplayName, generationArgs,
    });
    messages.push(...runtime.taskPreset.prompts.map((item) => ({ role: item.role, content: item.content })));
    diag.log(`分身#${task.id}(${clone.label}): 开始执行, 指令=${task.instruction.substring(0, 80)}..., 模型=${clone.modelName || "默认"}, 服务源=${clone.apiSource || "默认"}`);

    if (task.resumeTaskId !== undefined && task.resumeTaskId !== null && String(task.resumeTaskId) !== "") {
      const resume = loadCloneResumeSnapshot(username, {
        chatId,
        taskId: task.resumeTaskId,
        jobId: task.resumeJobId,
      });
      messages.push(...resume.messages.slice(1));
      messages.push({
        role: "system",
        content: getSystemText("clone_resume", username, charName)
          .replaceAll("{stop_reason}", String(resume.terminalReason ?? resume.stopReason))
          .replaceAll("{rounds}", String(resume.rounds))
          .replaceAll("{total_tools}", String(resume.totalTools))
          .replaceAll("{saved_at}", String(resume.savedAt || "未知"))
          .replaceAll("{instruction_preview}", String(resume.instruction || "").replace(/\s+/g, " ").substring(0, 120)),
      });
      diag.log(`分身#${task.id} 续接 resumeTaskId=${task.resumeTaskId} jobId=${resume.job.jobId}（载入${resume.messages.length}条上下文）`);
    }

    for (let round = 0; maxWorkRounds === 0 || round < maxWorkRounds; round++) {
      if (controller.signal.aborted) {
        terminalReason = parentAborted ? "parent_aborted" : "user_aborted";
        finalReply = finalReply || `[分身被中止，已执行${actualRounds}个工作轮/${totalTools}次工具调用]`;
        break;
      }
      logicalCalls++;
      const roundNumber = actualRounds + 1;
      const aiLifecycle = (event) => {
        const state = event?.phase === "waiting" ? "ai_waiting"
          : event?.phase === "queued" ? "ai_queued"
            : event?.phase === "granted" ? "ai_running"
              : event?.phase === "released" ? "ai_released"
                : event?.phase === "cancelled" ? "ai_cancelled"
                  : `ai_${event?.phase || "unknown"}`;
        const queueDetail = event?.queuePos ? `，队列第${event.queuePos}位` : "";
        status(roundNumber, state, `AI ${event?.tier || "lo"} ${event?.phase || "unknown"}${queueDetail}`, { ai: event });
      };
      const aiResult = await runMemoryPresetAI(username, charName, {
        ...runtime.taskPreset,
        id: `${runtime.taskPreset.id}_call${logicalCalls}`,
        prompts: messages.map((item) => ({ role: item.role, content: item.content, enabled: true })),
      }, runtime.memorySnapshot, charName, username, "", {
        maxRounds: 1,
        signal: controller.signal,
        chatId,
        aiPriority: { tier: "low", onLifecycle: aiLifecycle },
      });
      if (controller.signal.aborted) {
        terminalReason = parentAborted ? "parent_aborted" : "user_aborted";
        finalReply = finalReply || "(停止后返回的 AI 结果已丢弃)";
        break;
      }
      const completionSignal = parseCloneCompletion(aiResult?.reply || "");
      const content = completionSignal.content.replace(/<stopContinue\s*\/?>/gi, "").trim();
      const thinking = aiResult?.thinking || "";
      const logicalCall = {
        index: logicalCalls,
        providerRounds: Number(aiResult?.totalRounds) || 0,
        totalTimeMs: Number(aiResult?.totalTimeMs) || 0,
      };
      diag.log(`分身#${task.id} logicalCall#${logicalCalls} 工作轮${roundNumber}/${maxWorkRounds === 0 ? "∞" : maxWorkRounds}回复: ${content.length}字符`);

      if (content.length === 0 && completionSignal.explicit) {
        actualRounds = round + 1;
        terminalReason = "completed";
        completionEvidence = completionSignal.evidence;
        finalReply = completionEvidence;
        if (observe) roundDetails.push({ round: actualRounds, logicalCall, reply: "", thinking, toolCalls: [], toolResults: [], state: terminalReason, completionEvidence });
        break;
      }

      if (content.length === 0) {
        terminalReason = "no_output";
        if (observe) roundDetails.push({ round: roundNumber, logicalCall, reply: content, thinking, toolCalls: [], toolResults: [], state: terminalReason });
        diag.warn(`分身#${task.id} logicalCall#${logicalCalls}在AI调用层恢复后仍为空，Runner不再盲目重放`);
        finalReply = finalReply || `[分身AI调用层恢复后仍无输出，未消耗有效工作轮]`;
        break;
      }
      actualRounds = round + 1;
      finalReply = content;

      const { toolCalls, rejectedContentParams = [] } = parseIdeToolCallTags(content);
      const rawTagCount = (content.match(/<ideToolCall[\s>]/g) || []).length;
      if (rejectedContentParams.length > 0 || rawTagCount > toolCalls.length) {
        const parseError = rejectedContentParams.length > 0
          ? `⚠️ 你把代码内容写进了 ideToolCall 的属性里（${rejectedContentParams.join(", ")}）。请改用 <old_string>/<new_string> 子标签重写。`
          : `⚠️ 你输出了 ${rawTagCount} 个 ideToolCall 但只有 ${toolCalls.length} 个解析成功。请检查标签闭合和参数名后重写。`;
        messages.push({ role: "system", content: parseError });
        if (observe) roundDetails.push({ round: actualRounds, logicalCall, reply: content, thinking, toolCalls: toolCalls.map((item) => ({ tool: item.tool, params: item.params })), toolResults: [], state: "parse_error" });
        continue;
      }

      if (toolCalls.length === 0) {
        const bareText = content
          .replace(/<ideToolCall[\s\S]*?(\/>|<\/ideToolCall>)/gi, "")
          .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "")
          .trim();
        terminalReason = "completed";
        completionEvidence = completionSignal.evidence;
        if (observe) roundDetails.push({ round: actualRounds, logicalCall, reply: bareText, thinking, toolCalls: [], toolResults: [], state: terminalReason, completionEvidence });
        break;
      }

      // 保留 0811 未提交根修：重复签名包含稳定排序后的参数，不把读取不同文件误判为死循环。
      const toolSignature = toolCalls
        .map((item) => item.tool + "(" + Object.entries(item.params || {}).map(([key, value]) => `${key}=${String(value).slice(0, 120)}`).sort().join("&") + ")")
        .sort()
        .join(",");
      recentToolSignatures.push(toolSignature);
      if (recentToolSignatures.length > 5) recentToolSignatures.shift();
      if (recentToolSignatures.length >= 5 && recentToolSignatures.every((item) => item === toolSignature)) {
        repeatWarnings++;
        if (repeatWarnings >= 2) {
          terminalReason = "repeat_stopped";
          finalReply = finalReply || `[分身因连续重复操作而强制中断，已完成${totalTools}次工具调用]`;
          if (observe) roundDetails.push({ round: actualRounds, logicalCall, reply: content, thinking, toolCalls: toolCalls.map((item) => ({ tool: item.tool, params: item.params })), toolResults: [], state: terminalReason });
          break;
        }
        status(actualRounds, "warning", `重复操作检测：连续5轮 ${toolSignature}`);
        messages.push({ role: "system", content: getSystemText("clone_repeat_warning", username, charName).replaceAll("{tool_sig}", toolSignature) });
        recentToolSignatures.length = 0;
        if (observe) roundDetails.push({ round: actualRounds, logicalCall, reply: content, thinking, toolCalls: toolCalls.map((item) => ({ tool: item.tool, params: item.params })), toolResults: [], state: "repeat_warning" });
        continue;
      }

      const toolNames = toolCalls.map((item) => item.tool).join(", ");
      const outputPreview = content.replace(/<ideToolCall[\s\S]*?(\/>|<\/ideToolCall>)/gi, "").replace(/\s+/g, " ").trim().substring(0, 120);
      status(actualRounds, "working", `执行: ${toolNames}${outputPreview ? ` ｜ 💬${outputPreview}` : ""}`);
      const toolResults = [];
      for (const call of toolCalls) {
        if (controller.signal.aborted) break;
        const capability = resolveCloneCapability(clone, call.tool, call.params);
        if (!capability.eligible) {
          toolResults.push({
            tool: call.tool,
            params: call.params,
            result: {
              success: false,
              blocked: true,
              blockedBy: "clone_capability",
              capability: capability.capability,
              error: cloneCapabilityDeniedMessage(capability.capability, call.tool),
            },
          });
          continue;
        }
        if (call.tool === "web_search") {
          try {
            const query = String(call.params?.query || call.params?.keyword || "").trim();
            if (!query) {
              toolResults.push({ tool: "web_search", params: call.params, result: { success: false, error: "web_search 缺少 query 参数" } });
            } else {
              const webConfig = { ...(runtime.memorySnapshot.config?.web_search || {}) };
              if (call.params?.engine) webConfig.engine = call.params.engine;
              const searchResult = await executeWebSearch(query, webConfig);
              const text = (searchResult.results || []).length > 0
                ? `[联网搜索结果 (${searchResult.engine})]${searchResult.warning ? `\n⚠️ ${searchResult.warning}` : ""}\n${buildInjectableSearchText(searchResult.results, "分身联网搜索")}`
                : `[联网搜索无结果]${searchResult.error ? ` — ${searchResult.error}` : ""}`;
              const result = { success: (searchResult.results || []).length > 0 || !searchResult.error, result: text };
              toolResults.push({ tool: "web_search", params: call.params, result });
              ideClient._recordOperation?.({ tool: "web_search", params: call.params, result: { count: (searchResult.results || []).length, engine: searchResult.engine }, success: !searchResult.error, chatid: chatId, ownerUsername: username, timestamp: new Date().toISOString(), source: `分身#${task.id}`, sourceDetail });
            }
          } catch (error) {
            toolResults.push({ tool: "web_search", params: call.params, result: { success: false, error: error.message } });
          }
          continue;
        }
        if (call.tool === "web_download") {
          try {
            const url = String(call.params?.url || "").trim();
            if (!url) {
              toolResults.push({ tool: "web_download", params: call.params, result: { success: false, error: "web_download 缺少 url 参数" } });
            } else {
              const download = await executeWebDownload(url, { filename: call.params?.filename }, username, runtime.memorySnapshot.config?.web_search || {});
              const result = download.success
                ? { success: true, result: `[已下载] ${download.path} (${download.bytes} 字节)` }
                : { success: false, error: download.error };
              toolResults.push({ tool: "web_download", params: call.params, result });
              ideClient._recordOperation?.({ tool: "web_download", params: call.params, result: download, success: !!download.success, chatid: chatId, ownerUsername: username, timestamp: new Date().toISOString(), source: `分身#${task.id}`, sourceDetail });
            }
          } catch (error) {
            toolResults.push({ tool: "web_download", params: call.params, result: { success: false, error: error.message } });
          }
          continue;
        }
        try {
          const result = await ideClient.callToolWithLock(call.tool, call.params, chatId);
          toolResults.push({ tool: call.tool, params: call.params, result });
          ideClient._recordOperation({ tool: call.tool, params: call.params, result, success: result?.success !== false, chatid: chatId, ownerUsername: username, timestamp: new Date().toISOString(), source: `分身#${task.id}`, sourceDetail });
        } catch (error) {
          const result = { success: false, error: error.message };
          toolResults.push({ tool: call.tool, params: call.params, result });
          ideClient._recordOperation({ tool: call.tool, params: call.params, result, success: false, chatid: chatId, ownerUsername: username, timestamp: new Date().toISOString(), source: `分身#${task.id}`, sourceDetail });
        }
      }
      totalTools += toolResults.length;
      diag.log(`分身#${task.id} 第${actualRounds}个工作轮执行了 ${toolResults.length} 个工具 (累计${totalTools})`);
      if (observe) {
        roundDetails.push({
          round: actualRounds,
          logicalCall,
          reply: content,
          thinking,
          toolCalls: toolCalls.map((item) => ({ tool: item.tool, params: item.params })),
          toolResults,
          state: controller.signal.aborted ? "aborting" : "working",
        });
      }

      const contentForContext = await runtime.stripForContext(content);
      if (messages.length > 0 && messages[messages.length - 1].role === "assistant") messages[messages.length - 1].content = contentForContext;
      else messages.push({ role: "assistant", content: contentForContext });
      const resultText = toolResults.map((item) => {
        const result = item.result || {};
        if (result.success === false) return `--- ${item.tool} ---\n❌ ${result.error || "失败"}`;
        const value = typeof result.result === "string" ? result.result : JSON.stringify(result.result);
        return `--- ${item.tool}${result.duration ? ` (${result.duration}ms)` : ""} ---\n${value}`;
      }).join("\n\n");
      messages.push({ role: "user", content: getSystemText("clone_tool_result", username, charName).replaceAll("{results}", resultText) });
      if (maxWorkRounds > 0 && round >= maxWorkRounds - 3) {
        messages[messages.length - 1].content += getSystemText("clone_rounds_left", username, charName).replaceAll("{rounds_left}", String(maxWorkRounds - round - 1));
      }
    }

    const hasProgress = actualRounds > 0 || totalTools > 0 || finalReply.length > 0;
    const snapshotSaved = terminalReason === "completed" ? false : saveResume(terminalReason);
    return finalizeResult({ ...resultBase(snapshotSaved), reply: finalReply, ...cloneTerminalShape(terminalReason, hasProgress, snapshotSaved) });
  } catch (error) {
    if (controller.signal.aborted) {
      terminalReason = parentAborted ? "parent_aborted" : "user_aborted";
      const snapshotSaved = saveResume(terminalReason);
      return finalizeResult({ ...resultBase(snapshotSaved), reply: finalReply || "(在飞调用被中止)", ...cloneTerminalShape(terminalReason, actualRounds > 0 || totalTools > 0, snapshotSaved) });
    }
    diag.error(`分身#${task.id} 执行异常: ${error.message}\n${error.stack || ""}`);
    terminalReason = "exception";
    const snapshotSaved = saveResume(terminalReason);
    return finalizeResult({ ...resultBase(snapshotSaved), error: error.message, ...cloneTerminalShape(terminalReason, actualRounds > 0 || totalTools > 0 || finalReply.length > 0, snapshotSaved) });
  } finally {
    linkedSignal?.removeEventListener?.("abort", onParentAbort);
    unregisterCloneAbort(username, chatId, task.id, controller);
  }
}

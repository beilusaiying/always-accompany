/**
 * replyHandler.mjs — AI 回复标签解析与副作用分派中枢。
 *
 * 【功能链】
 *   AI 每轮生成结束后，解析回复中的 25+ 种结构化标签，驱动所有副作用：
 *   表格更新、记忆归档、记忆检索、联网搜索、热层写入、模式切换、IDE工具调用、
 *   委派/分身多轮执行、审批队列、进度广播、流程组创建、上下文清理等。
 *   最后触发 autoCheckArchiveTriggers（三层记忆 hot→warm→cold 自动搬迁）。
 *   不管生成请求构建（requestBuilder 的事），不管预设组装/注入（getPromptHandler + beilu-preset 的事），
 *   不管 AI API 调用（StructCall 的事）。
 *
 * 【why】
 *   AI 用标签而非 JSON 表达意图（对话自然语言友好），ReplyHandler 是框架侧唯一把标签语义
 *   转化为真实状态变更的地方。把所有副作用收口到此处而非各自分散，好处是：
 *   执行顺序可控（tableEdit 先于 memoryArchive，modeSwitch 先于 delegate），
 *   _memory_tags_processed 去重守卫防同轮双调，content_for_show 清理在所有副作用之后统一做。
 *
 * 【前端调用方式】
 *   前端不直接调用本模块。调用链：
 *     前端收到 AI 回复 → generation.mjs finalizeEntry()
 *     → 遍历插件 ReplyHandler 钩子 → main.mjs interfaces.ReplyHandler
 *     → 本模块 handleReply(reply, arg)
 *   副作用结果通过两条路径回到前端：
 *     1. reply.extension 结构化字段（_modeSwitch / _taskOverlay 等）随回复对象返回，
 *        前端监听并更新对应 UI 面板（任务清单 / 模式指示器等）
 *     2. WS broadcast 实时推送（emotion_changed / task_update / pending_approvals 等），
 *        前端 WS 监听器即时响应无需轮询
 *
 * 【关联链】
 *   ← generation.mjs finalizeEntry / runCodeRoundTriggers（R1 交叉）
 *   → ideClient.mjs（callToolAndStore / await submitPendingApproval / enqueuePendingResult — R3 IDE 交叉）
 *   → backgroundTasks.mjs（autoCheckArchiveTriggers → 触发 P2 总结 — R4 归档交叉）
 *   → beilu-regex ReplyHandler 在本模块之后由框架按插件序调用（R8 正则交叉，不在本文件内）
 *   → storage.mjs（loadMemoryData / saveTablesData / getActiveMode / setActiveMode）
 *   → tableEngine.mjs（executeTableOperations）
 *   → archiver.mjs（executeMemoryArchiveOps）
 *   → retrieval.mjs（executeMemorySearchOps）
 *   → aiRunner.mjs（runMemoryPresetAI — parallelDelegate / 分身子任务 AI 调用）
 *   → dataSystem.mjs（appendRouteEvent / detectRepeatedEdit — data 系统写操作埋点，线路/警告）
 *
 * 【影响范围】
 *   - 写文件：tables.json（tableEdit/memoryArchive）、code/active/*.md（codeMemoryWrite）、
 *     work/active/*.md（workMemoryWrite）、_delegate_queue.json（delegate/report）、
 *     _approval_queue.json（approval）、_parallel_results_{cid}.json（parallelDelegate）、
 *     _clone_runtime_{cid}.json（分身快照）、_operation_log.jsonl（每轮追加 opLog）、
 *     yonban_config.json（subModeSwitch/delegate/report 切模式）、eye_config.json（captureControl）、
 *     tasks.json（taskPlan/taskCheck）、code/active/{task}.route.jsonl/.state.json（ideToolCall route 埋点）
 *   - 广播 WS 事件：orb_message、emotion_changed、motion_triggered、task_update、
 *     cross_mode_task_update、tool_results_ready、pending_approvals、clone_status
 *   - 定时器：无（分身多轮循环是 await 同步串行，非 setInterval）
 *   - 改 reply 对象：reply.content_for_show（_stripAllTags 显示清理）、reply.extension（挂载
 *     _modeSwitch/_subModeSwitch/_taskOverlay/_parallelDelegateResults/_progress 等结构化数据）、
 *     reply._memory_tags_processed=true（去重守卫）
 *
 * 【使用效果】
 *   AI 的每一个结构化意图标签都被精确执行并落盘，前端实时收到状态变更广播，
 *   记忆表格、任务清单、IDE操作、模式切换等效果在本轮回复结束后即时生效，
 *   下一轮 GetPrompt 注入时即可读到更新后的状态。
 *
 * 标签处理序（编号步骤）：
 *   0. 前置：emotion/motion/orbMessage 抽取+广播 → XML 容错修复 → 预提取(needWebSearch/分身/presetSwitch/stopContinue)
 *   1. <tableEdit> → executeTableOperations + saveTablesData(await) + 记忆晋升 _global
 *   1b. <taskPlan>/<taskCheck> → taskStore CRUD + 广播 task_update
 *   2. <memoryArchive> → executeMemoryArchiveOps + saveTablesData(await)
 *   3. <memorySearch> → executeMemorySearchOps → 缓存供下轮 GetPrompt 注入
 *   3b. <needWebSearch> → executeWebSearch → 缓存供下轮 GetPrompt 注入
 *   4. <memoryNote> → parseMemoryNoteTags
 *   5. <codeMemoryWrite>/<workMemoryWrite> → 写热层 md（dataWrite 已删=2026-07-16 去重，框架/问题归记忆表格）
 *   6. <modeSwitch> → setActiveMode（per-chatId，chat→work/code 走投递语义不落盘）
 *   6b. <subModeSwitch> → skill组域门/回路检测（本入口专属）→ activateSubModeCore（D3 0804 三入口收口：
 *       map+activation记录+默认预设+事件体单源，autoAdvance 同走；delegate/report 仍 writeActiveSubModeId=legacy 写者）
 *   7. <ideToolCall> → 读写分离 → 安全检查 → 审批门/直接执行 → 外部修改检测 → route 埋点
 *   8. <delegate> → 委派队列入队 + 目标子模式切换
 *   8b. <parallelDelegate> → 并行 runMemoryPresetAI + pendingResults 同步注入
 *   9. <report> → 委派完成 + reality-gate 证据检查 + 切回源模式
 *   10. <approval>/<progress>/<needHelp> → 审批队列/进度/跨模式通知
 *   11. <createFlowGroup>/<captureControl>/<browserAction>/<mcpConnect> → 流程组/感知/浏览器/MCP
 *   12. <contextClean> → hideMessages 可逆隐藏 / purge 标记删除
 *   12b. <fileDelivery> → extension._fileDelivery
 *   13. <分身N> → 分身多轮循环执行 + pendingResults 注入
 *   14. <presetSwitch>(已废弃仅清理)/<stopContinue>/<scheduleWakeup>/<wakeWindow>/<sendToWindow>
 *   尾步：content_for_show 显示清理 → 输出管控正则 → _memory_tags_processed=true → autoCheckArchiveTriggers
 */
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { wbT, wbD } from "../../../../../server/wbStub.mjs";
import { readJsonSafe, readJsonSafeSync } from "../../../../../scripts/safeJsonIO.mjs"; // 0716 T019 差集收编：委派/审批队列损坏备份后抛（防空表 push 写回覆盖整表）
import { hasPreset as presetExists, createPreset as createBeiluPreset, applySubModePresetDefault, resolvePresetForMemoryAI } from "../ai/presetBridge.mjs";
import { activateSubMode as activateSubModeCore } from "../storage_mod/subModeActivation.mjs"; // D3 0804 三入口收口：<subModeSwitch>/autoAdvance 的 map+activation记录+默认预设+事件体统一走激活 owner
import { DEFAULT_INJECTION_DEPTH } from "../../prompt/preset/engine/preset_engine.mjs"; // T8·回切：改指 yonban 新位实现体
import { nicerWriteFileSync } from "../../../../../scripts/nicerWriteFile.mjs"; // M3：央原子写替裸 fs.writeFileSync 防半写损坏
import { sanitizeFilename } from "../../../../../scripts/sanitizeName.mjs"; // 0716 轮子收口：文件名安全清洗共享原语
import { V1_CONST } from "../../../../../server/web_server/v1_adapter.mjs";

import {
  __pluginDir,
  __projectRoot,
  diag,
  ensureMemoryDir,
  resolveGenerationMode, // 0715 mode 裁决单源收口：本文件全部模式读点在生成回复语境（handleReply 持 args），bot 壳请求按 platform 判 bot，不随 web 端 active_mode 漂移
  getMemoryDir,
  isPromotable,
  loadJsonFileIfExists,
  writeCloneRuntimeSnapshot,
  loadMemoryData,
  loadMemoryPresets,
  promoteToGlobal,
  resolveActiveSubModeId,
  resolveSubMode,
  writeActiveSubModeId,
  buildSubModeSwitchEvent,
  memoryCache,
  saveJsonFile,
  saveTablesData,
  setActiveMode,
  withFileLock, // 生产#5：_approval_queue read-modify-write 串行锁（央 storage.mjs:138），对齐 setDataActions M4 同名文件锁
  getYonbanConfigPath,
  updateYonbanConfig, // T4：yonban_config 子模式切换写点走字段级收口串行锁
  updateWorkConfig, // [0722 锁收口] W61 auto_advance 的 _work_config RMW 走串行锁（锁序恒 work外→yonban内）
  SKIP_SAVE, // mutator 哨兵：非 running/组文件缺失=不落盘（原「不进推进块不写」语义）
  appendPendingTasks, // T5-4：pending_tasks 落盘收口（解析层不再直写，handler 层走此写口）
  getCommandConfigPath,
  getEyeConfigPath,
  getGcCaptureRequestPath, // captureNow 即时截图请求标记(凛倾 2026-07-13"1做";写/删两端,读方=endpoints getdata)
  getWorkConfigPath,
  resolveWorkflowSlot,
  resolveSkillGroupDomain, // [0722 skill组隔离] <subModeSwitch> 接受域单源（running组优先→长期选中组），与宏清单同源
  getCodeConfigPath,
  isPathSafe, // 0716 路径前缀边界修复：收口内联 resolve().startsWith 到权威守卫
  DEFAULT_TOKEN_REMINDER,
} from "../storage_mod/storage.mjs";

import {
  parseMemoryArchiveTags,
  parseMemoryNoteTags,
  parseMemorySearchTags,
  parseOperationArgs,
  parseTableEditTags,
  parseVocabEditTags, // P9 词库维护 <vocab_edit>（0731 子模式化：正常对话链也要执行，不再只有 P 系列执行器）
} from "./replyParser.mjs";

// <vocab_edit> 执行层单点收口（与 aiRunner.runMemoryPresetAI 共享；preview→confirm 两态跨请求 pending 在模块级）
import { executeVocabEditOps } from "../tools/vocabEditExec.mjs";

import {
  applyTaskPlan,
  applyTaskCheck,
  loadTasks,
  remainingCount,
} from "../tools/taskStore.mjs";

import { executeTableOperations } from "../storage_mod/tableEngine.mjs";
import { runMemoryPresetAI } from "../ai/aiRunner.mjs";
import { inferCloneTaskType } from "../ai/cloneContract.mjs";
import { coordinateCloneBatch } from "../ai/cloneBatchCoordinator.mjs";
import { executeMemoryArchiveOps } from "../storage_mod/archiver.mjs";
import {
  executeMemorySearchOps,
  formatSearchResultsForAI,
} from "../storage_mod/retrieval.mjs";
// [0728 top-k] 主AI主动 <memorySearch> 也是真实召回事件：与 AI P1 同记入召回频率（单模块收口）
import { recordRecall, collectTouchedFiles } from "../storage_mod/recallStats.mjs";
import { autoCheckArchiveTriggers, archiveTableRowsGeneric } from "../tools/backgroundTasks.mjs";
// [0726「底部功能层.txt」第44行收口] 本文件是**传导层**（chat / 分身两条线路），只搬运不持有功能：
//   结果→AI 可读文本的格式化、相关度打印、不可信边界包裹三件事全在功能层 buildInjectableSearchText。
import { executeWebSearch, buildInjectableSearchText } from "../../web/webSearch.mjs";
import { executeWebDownload } from "../../web/webDownload.mjs"; // [0727 下载能力] URL→落盘，主AI/分身 ideToolCall 双入口拦截
import { extractEmotion, extractMotion, extractOrbMessage } from "../../render/emotionExtract.mjs"; // T3b·render 组：标签抽取纯逻辑单源
import { projectCompanionVisibleText } from "../../render/companionOutput.mjs";
import { WRITE_TOOLS_ALL, FILE_EDIT_TOOLS } from "../../../transport/ideClient.mjs";
import { createMcpConnectRequest } from "../../mcp/connectRequestStore.mjs";

/**
 * 并发上限池（多组并行/分身任务限流）。allSettled 语义——一个 thunk 崩不杀其余 worker。
 *
 * @param {Array<() => Promise>} thunks - 任务 thunk 数组，每项返回 Promise
 * @param {number} limit - 并发上限。0/负/>=thunks.length = 全并行；>0 = 池限流
 * @param {AbortSignal|null} signal - 外部中止信号（generation 取消时传入）
 * @returns {Promise<any[]>} 结果按原序返回（含 {status:"error"} 的失败项）
 */
async function _runWithConcurrency(thunks, limit = 0, signal = null) {
  const results = new Array(thunks.length);
  const _eff = (!limit || limit <= 0 || limit >= thunks.length) ? thunks.length : limit;
  let next = 0;
  const worker = async () => {
    while (next < thunks.length) {
      if (signal?.aborted) break;
      const i = next++;
      try {
        results[i] = await thunks[i]();
      } catch (e) {
        // R9: allSettled 语义 — 一个 thunk 崩不杀其余 worker。uncaught 是意外路径，必须打日志可定位
        const _msg = e?.message || String(e);
        try { diag.error(`_runWithConcurrency: thunk#${i} 未捕获异常(其余继续): ${_msg}\n${e?.stack || ""}`); } catch {}
        results[i] = { status: "error", error: _msg, _uncaught: true };
      }
    }
  };
  await Promise.all(Array.from({ length: _eff }, worker));
  return results;
}
// data 系统 v2：route 埋点 + 同处反复修改检测（per-char per-task 独立层）
import {
  appendRouteEvent as _dsAppendRouteEvent,
  editTargetOf as _dsEditTargetOf,
  targetLabel as _dsTargetLabel,
  detectRepeatedEdit as _dsDetectRepeatedEdit,
  upsertRepeatWarning as _dsUpsertRepeatWarning,
  getActiveWarnings as _dsGetActiveWarnings,
} from "../data/dataSystem.mjs";

import {
  lastProcessedTableEditHash,
  pendingChatSearchResults,
  chatSearchSlotKey,
  pendingTableEditFeedback,
  pluginEnabled,
} from "../ai/aiRunner.mjs";

import { computeTableEditHash } from "./replyParser.mjs";

import {
  checkCommandSecurity,
  evaluateWriteApprovalGate,
  ideClient,
  evaluateRuleDecision,
  isIdeToolResultMsg,
  parseIdeToolCallTags,
  parseQuestionTags,
  readFilesPermission,
} from "../../../transport/ideClient.mjs";

import { parseScheduleTaskTag } from "../../notification/scheduler.mjs";
import { loadPart } from "../../../../../server/parts_loader.mjs";
// N42 Bot 访问档位（L0-3）：从 args.chat_log 解析本轮触发者档位，非 Bot 来源返回 null=零变化。
// [P0-B] 返回形状扩展 {isBot, level, isOwner, hostControl, senderId, policyRev}（旧条目缺字段=fail-closed）。
import { resolveRequestBotPermission, notifyBotDelegateReport } from "../../../../../scripts/botContentShared.mjs";
// [P0-B 2026-08-03] 操作注册表 + 统一权限 admission：本文件所有可执行标签段先过 admitOperation
// 单一裁决（ModeDef 声明面=执行面 + Bot 档位/owner/宿主能力 fail-closed），禁再散写裸档位 if。
import { admitOperation } from "./operationRegistry.mjs";
import { dispatch } from "../../../dispatch/dispatcher.mjs"; // [0716 T3对接首批] 广播副作用改经 bus:broadcast 出口节点（exits.mjs），删 10 处动态 import broadcast.mjs 散拼样板

// 降噪#74：N42 Bot 访问档位拒绝告警 5 处逐字同模板（modeSwitch/ideToolCall/delegate/parallelDelegate/clone）合并 helper。
//   仍是 console.warn（正当安全审计 warn，有意灌监控面板，语义不变），仅消除前缀重复；opLog/wbD 各处不同保留原样。
function _warnBotPermGate(level, detail) { console.warn(`[beilu-memory] N42 Bot权限闸: L${level} 拒绝 ${detail}`); }

// F8: 委派/分身临时 id 防同毫秒撞 —— Date.now() 单独用作 id 时同毫秒并发会重复，
//   追加模块级单调计数器(base36)消歧。同毫秒同维度也不再撞。
let _delegSeq = 0;
function _delegId(prefix) { return `${prefix}_${Date.now().toString(36)}${(++_delegSeq).toString(36)}`; }

/**
 * bot 来源委派的服务端执行 worker（凛倾 07-09 中段链路空洞修复；三参照定型：
 * hermes kanban 链路B 同构=worker 独立执行→写 DB→通知回程，事件直调替代其 5s 轮询；
 * openvsx=任务状态机+完成才闭合；rowboat=轮次上限防循环）。
 *
 * why：<delegate> 只落队列+等下一轮生成注入（H1），web 闲置时 bot 发起的委派没有任何
 * 自主触发器产生那一轮生成=任务躺死。本 worker 在 bot 来源委派入队时 fire-and-forget 执行：
 * 目标子模式预设（_resolvePresetForSubMode）+ 委派上下文（与 H1 注入同字段：task/userMessage/
 * chatContext，机制性数据组装非新增指令文本）→ runMemoryPresetAI 多轮 → 写回队列同
 * <report> 落点（status/report/reportInjected=false）→ notifyBotDelegateReport 回程唤醒（§八链）。
 *
 * 竞态语义：写回前校验条目仍 active——期间被 getPromptHandler 判 timeout / 面板 cancel 则
 * 放弃写回（超时/取消语义优先，报告不覆盖）。失败也写 error 报告并唤醒（bot 告知用户，不静默）。
 * 只处理 bot 来源（web 来源维持既有人驱动/auto-continue 语义，零行为变化）。
 */
async function _runBotDelegateWorker(username, charName, dlg) {
  try {
    const _smCfg = loadJsonFileIfExists(getYonbanConfigPath(username), { sub_modes: [] });
    const _sm = (_smCfg.sub_modes || []).find(s => s.id === dlg.to);
    const _presetsData = loadMemoryPresets(username, charName);
    // [20260726 半接线补齐] 原传 null=丢掉发起对话的上下文：loadMemoryData 与下方 runMemoryPresetAI
    //   都按 chatId 解析模式（getActiveMode 读 active_modes_map[chatId]），传 null 会回退角色卡级
    //   active_mode（全局单值）→ 本委派可能读到「别的对话最后切的模式」的表格与热层。
    //   dlg.chatId 是发起委派那个对话的 id（:2358 _delegateCtx 已带），两处必须同槽。
    const _dlgCid = dlg?.chatId || null;
    const _memData = loadMemoryData(username, charName, undefined, _dlgCid);
    let _status = "completed";
    let _report = "";
    if (!_sm?.presetName) {
      _status = "error";
      _report = `(执行失败: 目标子模式"${dlg.to}"不存在或无绑定预设)`;
    } else {
      const _preset = resolvePresetForMemoryAI(username, _sm.presetName, _presetsData.presets);
      if (!_preset) {
        _status = "error";
        _report = `(执行失败: 预设"${_sm.presetName}"未找到——memory presets 和文件预设均无匹配)`;
      } else {
        // 任务消息=与 H1 注入完全同源的三字段（task/userMessage/chatContext），不新增指令文本
        const _taskParts = [dlg.task];
        if (dlg.userMessage) _taskParts.push(`[用户原话]\n${dlg.userMessage}`);
        if (dlg.chatContext) _taskParts.push(`[对话上下文]\n${dlg.chatContext}`);
        const _taskPreset = {
          ..._preset,
          id: _delegId(`BOTDLG_${dlg.to}`),
          prompts: [
            ...(_preset.prompts || []),
            { role: "user", content: _taskParts.join("\n\n"), enabled: true, builtin: false },
          ],
        };
        // 轮次上限：委派自带 maxRounds 钳到外部来源上限（用户可配 advanced_limits.delegate_max_rounds，0=无限，未设=回退 V1_CONST）
        const _dlgCfgMax = loadJsonFileIfExists(getYonbanConfigPath(username), {}).advanced_limits?.delegate_max_rounds;
        const _dlgEffMax = _dlgCfgMax !== undefined ? _dlgCfgMax : (V1_CONST.DELEGATE_EXTERNAL_MAX_ROUNDS || 10);
        const _rounds = _dlgEffMax > 0 ? Math.min(dlg.maxRounds || 10, _dlgEffMax) : (dlg.maxRounds || 10);
        // chatId 与上方 _memData 同槽（漏传=模式解析回退角色卡级，热层/表格/prompt组全给错模式）
        const _r = await runMemoryPresetAI(username, charName, _taskPreset, _memData, charName, username, "", { maxRounds: _rounds, aiPriority: "low", ...(_dlgCid ? { chatId: _dlgCid } : {}) }); // [0727 并发闸] delegate=后台级：本体>分身
        _report = _r?.reply || "(无输出)";
      }
    }
    // 写回队列（同 <report> 落点）：仅当条目仍 active（timeout/cancel 语义优先）
    const _qPath = path.join(ensureMemoryDir(username, charName), "work", "_delegate_queue.json");
    let _q = [];
    // [2026-08-01 批⑤危险#3] 读失败≠空队列——旧 catch{} 把文件损坏/ENOENT 折叠成 _q=[] → find=undefined
    //   → 误判"已非 active（不存在）" → 报告丢弃、任务永不完成。现：读失败诚实报错+报告仍保住（写报告文件兜底）。
    try { _q = JSON.parse(await fs.promises.readFile(_qPath, "utf-8")); } catch (qReadErr) {
      console.error(`[beilu-memory] bot 委派 worker: 队列文件读取失败(${qReadErr?.message})，报告写独立文件兜底`);
      try {
        const _fallbackPath = _qPath.replace(".json", `_orphan_${dlg.id}_${Date.now()}.json`);
        nicerWriteFileSync(_fallbackPath, JSON.stringify({ id: dlg.id, status: _status, report: _report, completedAt: new Date().toISOString(), error: "queue_read_failed" }, null, 2));
      } catch {}
      return;
    }
    const _item = _q.find(d => d.id === dlg.id);
    if (!_item || _item.status !== "active") {
      console.warn(`[beilu-memory] bot 委派 worker: ${dlg.id} 已非 active（${_item?.status || "不存在"}），放弃写回`);
      return;
    }
    _item.status = _status;
    _item.completedAt = new Date().toISOString();
    _item.report = _report;
    _item.reportInjected = false;
    nicerWriteFileSync(_qPath, JSON.stringify(_q, null, 2));
    console.log(`[beilu-memory] bot 委派 worker: ${dlg.id} → ${_status} (${_report.length} 字)`);
    // 回程唤醒（§八 链：H2 注入报告 → bot 出话发回来源频道）
    if (_item.sourceChannel && _item.sourceChannel.startsWith("bot:")) {
      notifyBotDelegateReport({
        platform: _item.sourceChannel.slice(4),
        username,
        charname: charName,
        channelId: _item.sourceChannelId || "",
        delegateId: _item.id,
      }).catch((e) => console.warn(`[beilu-memory] bot 委派 worker 回程唤醒失败:`, e?.message || e));
    }
  } catch (e) {
    console.error(`[beilu-memory] bot 委派 worker 异常 (${dlg?.id}):`, e?.message || e);
  }
}

/** 写操作工具名列表（引用 canonical WRITE_TOOLS_ALL，单一定义在 ideClient.mjs） */
const IDE_WRITE_TOOLS = [...WRITE_TOOLS_ALL];

// ═══════════════════════════════════════════════════════════════
// ★ 操作日志捕捉系统 — 滚动记录最近500条AI操作(成功+失败)
// ═══════════════════════════════════════════════════════════════
const _OP_LOG_MAX = 500;
const _opLogBuffer = [];
const _OP_LOG_FILE = path.join(__projectRoot, "data", "_operation_log.jsonl");

// S4修: wakeWindow/sendToWindow 防循环 Map（原 _wwRecent 自引用在 ESM 中是 ReferenceError）
const _wwRecent = new Map();
const _stwRecent = new Map();

// T1: 编程模式表格清理轮次计数器（跨轮持久化）。原 [BUG]：轮次读写 reply.extension（每轮新建临时对象）
//   恒 0 → 清理提醒永不触发。改存模块级 Map（同 _switchLoopCounter 范式，key=username/charName/chatId），
//   跨轮累积正确；进程内持久（重启从 0 重新计数=清理提醒周期性重新累积，语义可接受，非归档数据不落盘）。
const _tableCleanRounds = new Map();

// W73: 纠错→测试回路终止保护 — 超过 _SWITCH_LOOP_MAX 次双向切换视为设计层死循环，强制停止
const _switchLoopCounter = new Map();
const _SWITCH_LOOP_MAX_DEFAULT = 15;
function _checkSwitchLoop(username, charName, from, to, chatId) {
  const key = `${username}/${charName}/${chatId || "_"}`;
  const _cached = memoryCache.get(`${username}/${charName}`);
  const _yonCfg = loadJsonFileIfExists(getYonbanConfigPath(username), {}).advanced_limits?.switch_loop_max;
  const _max = _yonCfg !== undefined ? _yonCfg : (_cached?.config?.safety?.sub_mode_switch_max || _SWITCH_LOOP_MAX_DEFAULT);
  let rec = _switchLoopCounter.get(key);
  if (!rec) { rec = { count: 0, lastReset: Date.now() }; _switchLoopCounter.set(key, rec); }
  if (Date.now() - rec.lastReset > 5 * 60 * 1000) { rec.count = 0; rec.lastReset = Date.now(); }
  rec.count++;
  if (_max > 0 && rec.count > _max) {
    diag.warn(`subModeSwitch 回路检测: ${from}→${to} 已切换${rec.count}次(超过${_max}次上限)，强制停止`);
    return true;
  }
  return false;
}

/**
 * 记录一条操作日志
 * @param {string} category - 分类(实际产出值): entry/tableEdit/memoryArchive/memorySearch/webSearch/codeMemoryWrite/workMemoryWrite/modeSwitch/ideToolCall/delegate/report/approval/progress/needHelp/contextClean/fileDelivery/clone/scheduleWakeup/error
 * @param {string} action - 动作描述
 * @param {object} detail - 详情
 * @param {"ok"|"fail"|"skip"|"blocked"} status - 状态
 */
function opLog(category, action, detail = {}, status = "ok") {
  const entry = {
    t: new Date().toISOString(),
    cat: category,
    act: action,
    st: status,
    d: detail,
  };
  _opLogBuffer.push(entry);
  if (_opLogBuffer.length > _OP_LOG_MAX) _opLogBuffer.splice(0, _opLogBuffer.length - _OP_LOG_MAX);
  // 异步追加到文件（不阻塞主流程）
  try {
    fs.appendFileSync(_OP_LOG_FILE, JSON.stringify(entry) + "\n");
    // 文件行数超限时截断（每50条检查一次）
    if (_opLogBuffer.length % 50 === 0) {
      try {
        const lines = fs.readFileSync(_OP_LOG_FILE, "utf-8").split("\n").filter(Boolean);
        if (lines.length > _OP_LOG_MAX) {
          nicerWriteFileSync(_OP_LOG_FILE, lines.slice(-_OP_LOG_MAX).join("\n") + "\n");
        }
      } catch {}
    }
  } catch {}
}

/** 获取最近N条日志（供外部查询） */
export function getOperationLog(n = 50) {
  return _opLogBuffer.slice(-n);
}

import {
  createTableSnapshot,
} from "../../rollback/tableSnapshot.mjs";

/**
 * 加载用户自定义的标签清理规则
 * 文件: data/users/{username}/strip_tags_custom.json
 * 格式: { "tags": ["tagName1"], "patterns": ["<regex>"] }
 */
async function _loadCustomStripPatterns(username) {
  if (!username) return [];
  const cfgPath = path.join(__projectRoot, "data", "users", username, "strip_tags_custom.json");
  if (!fs.existsSync(cfgPath)) return [];
  try {
    const cfg = JSON.parse(await fs.promises.readFile(cfgPath, "utf-8"));
    const patterns = [];
    if (Array.isArray(cfg.tags)) {
      for (const tag of cfg.tags) {
        if (typeof tag === "string" && /^[\w\u4e00-\u9fff-]+$/.test(tag)) {
          patterns.push(`<${tag}[\\s>][\\s\\S]*?<\\/${tag}>`);
          patterns.push(`<${tag}\\s[^>]*?\\/>`);
          patterns.push(`<${tag}\\s*\\/>`);
        }
      }
    }
    if (Array.isArray(cfg.patterns)) {
      for (const p of cfg.patterns) {
        if (typeof p === "string" && p.length <= 500) patterns.push(p);
      }
    }
    return patterns;
  } catch (e) {
    wbD(null, "memory", "loadCustomStripPatterns", false, e.message, {});
    console.warn("[beilu-memory] strip_tags_custom.json 读取失败:", e.message);
    return [];
  }
}

/**
 * 统一清理 AI 回复中的所有操作标签，生成 content_for_show（「show 显示」剥离语义）。
 * 与 getPromptHandler._stripConsumedTagsFromInjection 的「模型上下文」剥离语义不同——
 * 本函数保留部分标签给 beilu-regex 美化正则（如 MVU 系 UpdateVariable/JSONPatch），
 * 不要跨文件强行统一清单。
 * 包含 G6 未闭合兜底：AI 漏写闭合标签时从开标签删到末尾。
 *
 * @param {string} text - AI 原始回复文本
 * @param {string[]} extraPatterns - 用户自定义额外正则模式（来自 strip_tags_custom.json）
 * @returns {string} 清理后的显示文本
 */
function _stripAllTags(text, extraPatterns, petTagNames) {
  let result = text
    .replace(/<tableEdit>[\s\S]*?<\/tableEdit>/gi, "")
    .replace(/<taskPlan>[\s\S]*?<\/taskPlan>/gi, "")
    .replace(/<taskCheck\s[^>]*?\/>|<taskCheck>[\s\S]*?<\/taskCheck>/gi, "")
    .replace(/<memoryArchive>[\s\S]*?<\/memoryArchive>/gi, "")
    .replace(/<memorySearch>[\s\S]*?<\/memorySearch>/gi, "")
    .replace(/<needWebSearch>[\s\S]*?<\/needWebSearch>/gi, "")
    .replace(/<memoryNote[^>]*>[\s\S]*?<\/memoryNote>/gi, "")
    .replace(/<codeMemoryWrite[^>]*>[\s\S]*?<\/codeMemoryWrite>/gi, "")
    .replace(/<workMemoryWrite[^>]*>[\s\S]*?<\/workMemoryWrite>/gi, "")
    .replace(/<modeSwitch>[\s\S]*?<\/modeSwitch>/gi, "")
    .replace(/<subModeSwitch>[\s\S]*?<\/subModeSwitch>/gi, "")
    .replace(/<ideToolCall\s[^>]*?\/>|<ideToolCall\s[^>]*?>[\s\S]*?<\/ideToolCall>/gi, "")
    // [0717 范式迁移配套] ppt_op/mcp-* 调用原文留在 content 落盘(AI 下轮可见),展示态与 ideToolCall
    //   同款剥离——执行状态由回合末 system 条的 inline 工具卡呈现(凛倾"指令还在没执行"实为裸露误读)。
    //   未闭合标签(截断半失败)不剥=保留诊断可见性,与半失败反馈(ppt.op_incomplete)配套。
    //   [0717 吞噬事故配套] body 加 (?!<ppt_op\b) 前瞻取最内层——散文提及 `<ppt_op>` 字样曾把
    //   "提及→真实块闭合"整段误剥(连 AI 正常句子一起吞)；与 beilu-ppt parsePptOps 正则同语义。
    .replace(/<ppt_op\b[^>]*?\/>|<ppt_op\b[^>]*?>(?:(?!<ppt_op\b)[\s\S])*?<\/ppt_op>/gi, "")
    .replace(/<mcp-[\w-]+\b[^>]*?\/>|<mcp-[\w-]+\b[^>]*?>[\s\S]*?<\/mcp-[\w-]+>/gi, "")
    .replace(/<scheduleTask>[\s\S]*?<\/scheduleTask>/gi, "")
    .replace(/<delegate\s[^>]*>[\s\S]*?<\/delegate>/gi, "")
    .replace(/<parallelDelegate>[\s\S]*?<\/parallelDelegate>/gi, "")
    .replace(/<report[\s\S]*?<\/report>/gi, "")
    .replace(/<approval[\s\S]*?<\/approval>/gi, "")
    .replace(/<createFlowGroup>[\s\S]*?<\/createFlowGroup>/gi, "")
    .replace(/<contextClean>[\s\S]*?<\/contextClean>/gi, "")
    .replace(/<captureControl>[\s\S]*?<\/captureControl>/gi, "")
    .replace(/<browserAction>[\s\S]*?<\/browserAction>/gi, "")
    .replace(/<mcpConnect>[\s\S]*?<\/mcpConnect>/gi, "")
    .replace(/<分身\d+[^>]*>[\s\S]*?<\/分身\d+>/gi, "")
    .replace(/<stopContinue\s*\/?>/gi, "")
    .replace(/<scheduleWakeup\s[^>]*?\/?>/gi, "")
    .replace(/<wakeWindow\s[^>]*?\/?>/gi, "")
    .replace(/<progress[\s\S]*?<\/progress>/gi, "")
    .replace(/<needHelp[\s\S]*?<\/needHelp>/gi, "")
    .replace(/<file_op\s[^>]*>[\s\S]*?<\/file_op>/gi, "")
    .replace(/<search>[\s\S]*?<\/search>/gi, "")
    .replace(/<bot_reply>[\s\S]*?<\/bot_reply>/gi, "")
    .replace(/<toggle>[\s\S]*?<\/toggle>/gi, "")
    .replace(/<orbMessage>[\s\S]*?<\/orbMessage>/gi, "")
    .replace(/<emotion>[\s\S]*?<\/emotion>/gi, "")
    .replace(/<motion(?:\s[^>]*)?>[\s\S]*?<\/motion>/gi, "")
    .replace(/<motion\s[^>]*?\/>/gi, "")
    .replace(/<completionVerify(?:\s[^>]*)?\/>|<completionVerify(?:\s[^>]*)?>[\s\S]*?<\/completionVerify>/gi, "")
    .replace(/<sendToWindow\s[^>]*?>[\s\S]*?<\/sendToWindow>/gi, "")
    .replace(/<fileDelivery>[\s\S]*?<\/fileDelivery>/gi, "")
    .replace(/<presetSwitch>[\s\S]*?<\/presetSwitch>/gi, "")
    .replace(/<chatRename>[\s\S]*?<\/chatRename>/gi, "")
    .replace(/<(?:beilu|work|ide|clone|memory)-[\w]+[^>]*>[\s\S]*?<\/(?:beilu|work|ide|clone|memory)-[\w]+>/gi, "")
    .replace(/<(?:beilu|work|ide|clone|memory)-[\w]+\s[^>]*?\/>/gi, "");

  // 表情/动作/orb 标签名可配置(2026-07-09 机制补全):剥离跟随配置——此前只剥字面量默认名(:531-534),
  //   用户改标签名后抽取跟随而剥离不跟随=原始标签漏进显示文本(旧方案 punt 用户手动补 strip_tags_custom=半个机制)。
  //   名字已过 _safeTag 同款白检(词字符/中文/连字符),无正则元字符,直接内插安全。默认名重复剥=幂等。
  const _petTags = Array.isArray(petTagNames) ? petTagNames : [];
  for (const _t of _petTags) {
    try {
      result = result
        .replace(new RegExp(`<${_t}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${_t}>`, "gi"), "")
        .replace(new RegExp(`<${_t}\\s[^>]*?\\/>`, "gi"), "");
    } catch (_) { /* 名字异常:跳过,不影响其余剥离 */ }
  }

  // G6 未闭合兜底：AI 漏写闭合标签时，含内容的指令标签从开标签删到末尾（对齐 stripReasoningTags 的 unclosed fallback）
  for (const _t of ["tableEdit","memoryArchive","memorySearch","ideToolCall","orbMessage","emotion","motion","report","approval","delegate","parallelDelegate","createFlowGroup","needWebSearch","scheduleTask","memoryNote","codeMemoryWrite","workMemoryWrite","completionVerify","progress","needHelp","chatRename",..._petTags]) {
    if (result.includes(`<${_t}`) && !result.includes(`</${_t}>`)) {
      try { result = result.replace(new RegExp(`<${_t}[\\s>][\\s\\S]*$`, "i"), ""); } catch (_) {}
    }
  }

  if (extraPatterns && extraPatterns.length > 0) {
    for (const pat of extraPatterns) {
      try {
        result = result.replace(new RegExp(pat, "gi"), "");
      } catch (_) { /* invalid regex, skip */ }
    }
  }

  return result.trim();
}

/**
 * 解析 <taskPlan> 标签体 → 任务数组（F3）。
 * 支持两种格式：
 *  1. JSON 数组：[{"content":"...","status":"in_progress","priority":"high"}, ...]
 *  2. 行清单：每行一条任务，可带前缀状态标记
 *     - [x] / ✓ / [done]  → completed
 *     - [~] / [>] / [doing] → in_progress
 *     - [ ] / - / 1. / 无标记 → pending
 * @param {string} body 标签内文本
 * @returns {Array<{content,status,priority}>}
 */
function _parseTaskPlanBody(body) {
  const raw = (body || "").trim();
  if (!raw) return [];
  // JSON 优先
  if (raw.startsWith("[") || raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw);
      const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed.tasks) ? parsed.tasks : null;
      if (arr) {
        return arr
          .map((t) => (typeof t === "string" ? { content: t } : t))
          .filter((t) => t && String(t.content ?? "").trim());
      }
    } catch (_) { /* 退化到行清单解析 */ }
  }
  // 行清单
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    let s = line.trim();
    if (!s) continue;
    let status = "pending";
    // 状态前缀
    const _doneM = s.match(/^(?:\[\s*[x✓×√]\s*\]|✓|✅|\[done\])\s*/i);
    const _doingM = s.match(/^(?:\[\s*[~>]\s*\]|⏳|\[doing\]|\[进行中\])\s*/i);
    const _todoM = s.match(/^(?:\[\s*\]|☐|\[todo\]|\[待办\])\s*/i);
    if (_doneM) { status = "completed"; s = s.slice(_doneM[0].length); }
    else if (_doingM) { status = "in_progress"; s = s.slice(_doingM[0].length); }
    else if (_todoM) { s = s.slice(_todoM[0].length); }
    // 列表序号/项目符号前缀（- * • 1. 1) 等）
    s = s.replace(/^(?:[-*•]\s+|\d+[.)、]\s*)/, "").trim();
    if (s) out.push({ content: s, status });
  }
  return out;
}

/**
 * 解析所有 <taskCheck> → 选择器数组（F3）。
 * 形态：
 *  <taskCheck id="t123"/>              按 id 勾
 *  <taskCheck content="整句任务"/>      按 content 勾
 *  <taskCheck>整句任务内容</taskCheck>   块式，体即 content
 *  <taskCheck status="in_progress" id="..."/>  可选改成其它状态（默认 completed）
 * @param {string} content
 * @returns {Array<{id?:string, content?:string, status?:string}>}
 */
function _parseTaskCheckBody(content) {
  const out = [];
  // 自闭合属性式
  const _selfRe = /<taskCheck\s([^>]*?)\/>/gi;
  let m;
  while ((m = _selfRe.exec(content)) !== null) {
    const attrs = m[1];
    const id = attrs.match(/id="([^"]*)"/i)?.[1];
    const c = attrs.match(/content="([^"]*)"/i)?.[1];
    const status = attrs.match(/status="([^"]*)"/i)?.[1];
    if (id || c) out.push({ id, content: c, status });
  }
  // 块式 <taskCheck ...>body</taskCheck>
  const _blockRe = /<taskCheck(\s[^>]*)?>([\s\S]*?)<\/taskCheck>/gi;
  while ((m = _blockRe.exec(content)) !== null) {
    const attrs = m[1] || "";
    const id = attrs.match(/id="([^"]*)"/i)?.[1];
    const status = attrs.match(/status="([^"]*)"/i)?.[1];
    const body = (m[2] || "").trim();
    if (id) out.push({ id, content: body || undefined, status });
    else if (body) out.push({ content: body, status });
  }
  return out;
}

/**
 * AI 回复标签解析与副作用分派主函数（25+ 种标签）。
 *
 * 链路：generation.mjs finalizeEntry → 各插件 ReplyHandler → 本函数
 *       → 解析标签并执行副作用 → _stripAllTags 生成 content_for_show
 *       → autoCheckArchiveTriggers 触发记忆归档（含 P2 回调）
 * 影响：
 *   - 修改 reply 对象（content_for_show / extension.* / _memory_tags_processed）
 *   - 写表格（tableEdit/memoryArchive → await saveTablesData，H7 修复）
 *   - 写热层 md（codeMemoryWrite/workMemoryWrite）
 *   - IDE 工具执行（ideToolCall → callToolAndStore / await submitPendingApproval）
 *   - 分身/并行委派 AI 调用（阻塞式 runMemoryPresetAI）
 *   - 多种 WS 广播（emotion_changed / tool_results_ready / task_update 等）
 * 约束：
 *   - reply._memory_tags_processed 去重——同一 reply 不会被处理两次
 *   - _qcid 收口：pendingResults 入队 chatid 在 _cid 为 falsy 时用合成 id（防 null 项误入广播分支）
 *   - Bot 来源按 N42 档位（L0-L3）路由各标签通道（L<3 跳过 ideToolCall/modeSwitch/分身，L<2 跳过 delegate）
 *
 * @param {object} reply - AI 回复对象：{ content, content_for_show?, extension?, _memory_tags_processed? }
 * @param {object} args - beilu 框架参数：{ username, char_id, chatid, chat_name, chat_log[], generation_options?, sourceChannel? }
 * @returns {Promise<boolean>} 始终返回 false（框架约定：不中断后续插件 ReplyHandler 链）
 */
export async function handleReply(reply, args) {
  // ★ 操作日志：记录入口
  const _replyLen = reply?.content?.length || 0;
  const _tagSummary = [];
  if (reply?.content) {
    if (reply.content.includes("<tableEdit")) _tagSummary.push("tableEdit");
    if (reply.content.includes("<taskPlan")) _tagSummary.push("taskPlan");
    if (reply.content.includes("<taskCheck")) _tagSummary.push("taskCheck");
    if (reply.content.includes("<memoryArchive")) _tagSummary.push("memoryArchive");
    if (reply.content.includes("<memorySearch")) _tagSummary.push("memorySearch");
    if (reply.content.includes("<memoryNote")) _tagSummary.push("memoryNote");
    if (reply.content.includes("<codeMemoryWrite")) _tagSummary.push("codeMemoryWrite");
    if (reply.content.includes("<modeSwitch")) _tagSummary.push("modeSwitch");
    if (reply.content.includes("<subModeSwitch")) _tagSummary.push("subModeSwitch");
    if (reply.content.includes("<ideToolCall")) _tagSummary.push("ideToolCall");
    if (reply.content.includes("<delegate")) _tagSummary.push("delegate");
    if (/<分身\d+>/.test(reply.content)) _tagSummary.push("clone");
    if (reply.content.includes("<scheduleTask")) _tagSummary.push("scheduleTask");
    if (reply.content.includes("<approval")) _tagSummary.push("approval");
    if (reply.content.includes("<contextClean")) _tagSummary.push("contextClean");
    if (reply.content.includes("<createFlowGroup")) _tagSummary.push("createFlowGroup");
    if (reply.content.includes("<presetSwitch")) _tagSummary.push("presetSwitch");
    if (reply.content.includes("<needWebSearch")) _tagSummary.push("needWebSearch");
    if (reply.content.includes("<stopContinue")) _tagSummary.push("stopContinue");
    if (reply.content.includes("<chatRename")) _tagSummary.push("chatRename");
  }
  opLog("entry", "handleReply", { len: _replyLen, tags: _tagSummary, user: args?.username, char: args?.char_id });

  const _cid = args?.chatid || (args?.chat_name ? args.chat_name.replace("common_chat_", "") : null);
  // ★ F4 残余 null 入队源收口（session9）：本函数内 ideClient.enqueuePendingResult({chatid:_qcid(_cid)}) 都是
  //   「定向给本回复会话」语义——结果属于发起这轮回复的那个 chat，绝不该广播。但 consumePendingResults
  //   (ideClient.mjs consumePendingResults) 把 chatid 为 falsy 的项当成「广播给所有会话」（F4 null 项语义，专为 worker runner 等
  //   无会话归属老调用方设计，不经本函数）。当 _cid 落 falsy 兜底（args 既无 chatid 又无 chat_name 的边界回合），
  //   这些定向项会误入广播分支、污染所有打开会话（每会话各收一次，linger 10min）。
  //   收口只作用于「入队 chatid」这一个语义边界：_cid 仍保留真实/null 语义供文件名(_recall/_parallel_results)、
  //   记忆/task 隔离、子模式状态、broadcast 等沿用（它们都已自带 if(_cid) 守卫，null 时正确跳过）；唯独喂进
  //   pendingResults 的 chatid 用 _qcid——falsy 时换成回合唯一的合成定向标识(不匹配任何真实 chatid，消费端各
  //   会话都不会误收，项由队列上限 ideClient.mjs enqueuePendingResult 内 CAP 截断 或 worker 无主 drain 清理)，从根上断掉「无主
  //   定向项→广播」的误映射。正常回合 args.chatid 存在时 _qcid===_cid===真实 chatid，与 generation.mjs 消费端
  //   consumePendingResults(chatid) 同源、定向命中，行为零变化。
  const _qcid = _cid || `__noChat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  if (_cid && args?.username) {
    const _ownerBinding = ideClient.registerChatOwner?.(_qcid, args.username);
    if (_ownerBinding === false) {
      wbD(_cid, "memory", "handleReply:ownerMismatch", false, "会话 owner 绑定冲突，工具结果将 fail-closed", {});
    }
  }
  wbT(_cid, "memory", "handleReply:enter", { len: _replyLen, tags: _tagSummary });

  const _hasIdeToolCall = reply?.content?.includes?.("<ideToolCall") || false;
  if (_hasIdeToolCall) {
  }

  if (!pluginEnabled) {
    if (_hasIdeToolCall) console.warn("[beilu-memory] ReplyHandler: pluginEnabled=false，跳过 ideToolCall 处理！");
    opLog("entry", "skip-disabled", { reason: "pluginEnabled=false" }, "skip");
    return false;
  }
  if (!reply || !reply.content) return false;

  const username = args?.username;
  const charName = args?.char_id;
  if (!username || !charName) return false;

  // 生成层权威回复坐标：新链路直接传 reply_message_id/index，避免并发续轮时
  // GetChatLogLength()-1 被更晚消息推移。旧调用方未传 index 时才回退原有长度算法。
  let _replyCoordinatesPromise = null;
  const _getReplyCoordinates = () => {
    if (_replyCoordinatesPromise) return _replyCoordinatesPromise;
    _replyCoordinatesPromise = (async () => {
      const chatId = _cid || "";
      const suppliedId = typeof args?.reply_message_id === "string" && args.reply_message_id
        ? args.reply_message_id
        : (typeof reply?.id === "string" ? reply.id : "");
      if (Number.isInteger(args?.reply_message_index) && args.reply_message_index >= 0) {
        return { chatId, messageIndex: args.reply_message_index, messageId: suppliedId };
      }
      let messageIndex = -1;
      if (chatId) {
        try {
          const chatOpsPath = path.join(
            __pluginDir, "..", "..", "shells", "beilu-chat", "src", "lib", "chatOps.mjs",
          );
          const chatOps = await import(pathToFileURL(chatOpsPath).href);
          const logLen = await chatOps.GetChatLogLength(chatId);
          messageIndex = logLen > 0 ? logLen - 1 : -1;
        } catch { /* 旧链路无 chatOps 时保留 -1 语义 */ }
      }
      return { chatId, messageIndex, messageId: suppliedId };
    })();
    return _replyCoordinatesPromise;
  };

  // 任务D: 标记消息所属模式
  if (!reply.extension) reply.extension = {};
  reply.extension._mode = resolveGenerationMode(args, username, charName, _cid);

  // N42 Bot 访问档位（80单§一，Bot设计 :470-489）：解析本轮触发者档位。
  // 非 Bot 来源（本地用户）= null = 零行为变化（回归红线）。Bot 来源按档位路由各通道：
  //   L<3 → ideToolCall / 分身 / modeSwitch 整通道跳过（标签照剥）；L<2 → delegate / parallelDelegate 跳过。
  const botPerm = resolveRequestBotPermission(args?.chat_log);
  if (botPerm) opLog("entry", "botPermission", { level: botPerm.level, isOwner: botPerm.isOwner, hostControl: botPerm.hostControl, senderId: botPerm.senderId }, "ok");

  // ═══════════════════════════════════════════════════════════════
  // [P0-B 2026-08-03] 统一权限 admission（operationRegistry 单一裁决数据源）。
  // 用法：各标签段执行前 `_admit("<opId>", "<detail>")`——true=放行走既有执行体；
  // false=已完成可见拒绝三件套（opLog blocked + wbD + _operation_denied pendingResult 回喂 AI），
  // 调用方只需跳过执行（标签由既有 replace/_stripAllTags 照剥，不"执行后清标签"）。
  // 裁决维度：ModeDef 声明面=执行面（requiredModeFeature）+ Bot 档位/ownerOnly/宿主能力（fail-closed）。
  // 本地来源（botPerm=null）只受 ModeDef 声明维度约束——本地用户权限走既有 permission_level/审批门/规则集。
  // ═══════════════════════════════════════════════════════════════
  const _denyOperation = (opId, decision, detail) => {
    opLog(opId, "operation_denied", { code: decision.code, reason: decision.reason, detail }, "blocked");
    wbD(_cid, "memory", `handleReply:deny:${opId}`, false, `${decision.code}: ${decision.reason}`, { detail });
    if (botPerm) _warnBotPermGate(botPerm.level, `${opId}${detail ? " " + detail : ""}（${decision.code}）`);
    try {
      ideClient.enqueuePendingResult({
        tool: "_operation_denied",
        params: { op: opId, code: decision.code },
        result: { success: false, error: `🚫 操作 ${opId} 被权限门拒绝：${decision.reason}` },
        chatid: _qcid,
        ownerUsername: username,
        timestamp: new Date().toISOString(),
      });
    } catch { /* 拒绝回喂入队失败仅日志（opLog/wbD 已记账） */ }
  };
  const _admit = (opId, detail = "") => {
    const decision = admitOperation(opId, { mode: reply?.extension?._mode, botPerm });
    if (!decision.allowed) _denyOperation(opId, decision, detail);
    return decision.allowed;
  };

  // T6-S1: 取本轮召回落盘(getPromptHandler 写)，挂到 reply.extension 做「运用可溯源」。
  // consume-once(读后删) + 10min 新鲜窗，防止上一轮未消费的残留误标到本轮回复。
  if (_cid) {
    try {
      const _rcFile = path.join(getMemoryDir(username, charName), "_recall", `${_cid}.json`);
      if (fs.existsSync(_rcFile)) {
        const _rcData = JSON.parse(await fs.promises.readFile(_rcFile, "utf-8"));
        fs.rmSync(_rcFile, { force: true });
        if (_rcData && Array.isArray(_rcData.items) && _rcData.items.length && (Date.now() - (_rcData.ts || 0) < 600000)) {
          reply.extension._recalledMemory = _rcData.items;
        }
      }
    } catch (_rcErr) { /* 溯源标记失败不影响回复主流程 */ }
  }

  try {
    if (reply._memory_tags_processed) {
      if (_hasIdeToolCall) console.warn("[beilu-memory] ReplyHandler: _memory_tags_processed=true，跳过重复处理");
      return false;
    }

    // <emotion> 标签抽取后【透传】给桌宠/Live2D 端。先于 orbMessage 块算好 _petEmotion,
    // 使其既能随 orbMessage 一并下发桌面端(投2)、又供 emotion_changed WS 广播(投1)——同一抽取点单次算，不重复抽。
    // 框架层归位(删原硬编码 5 值白名单 ["neutral","happy","sad","blush","angry"]):情绪是否"合法"只有【模型自己】知道
    //   ——它的 emotionMap/表情集配了哪些情绪。校验放在反代层=越界且把全产品的情绪上限钉死在 5 个。渲染层 setEmotion 是唯一权威:
    //   配了的命中、没配的优雅降级(无表情不报错)。此处只做基本卫生(限长+字符集),防把任意内容塞进广播。
    // T3b·render 组：抽取纯逻辑归位 functions/render/emotionExtract.mjs（同一正则同一卫生校验，行为等价）；
    // 副作用（广播/双投）留本宿主（去向属出口节点域）。
    // 标签名可配置(凛倾 2026-07-09"禁止硬编码,包括标签"):权威=pet_settings.emotionTag/motionTag(缺省 emotion/motion)。
    //   读同一权威源 injection_state(动态 import 同 :645 orb 范式);读失败=默认标签,不影响主回复。
    //   注:改名后默认剥离(:393)不再命中新标签,用户经既有可编辑机制 strip_tags_custom.json 补剥(tags 数组加同名即可)。
    let _emoTagName, _motTagName, _orbTagName;
    try {
      const _tagMod = await import(new URL("../../screenshot/injection_state.mjs", import.meta.url).href);
      const _tagPs = _tagMod.loadPetSettingsStore ? _tagMod.loadPetSettingsStore(__projectRoot) : {};
      _emoTagName = _tagPs && _tagPs.emotionTag;
      _motTagName = _tagPs && _tagPs.motionTag;
      _orbTagName = _tagPs && _tagPs.orbMessageTag; // 2026-07-09 收口审计:orbMessage 补齐可配置范式(同组唯一漏配)
    } catch { /* 配置不可读:用默认标签 */ }
    const _petEmotion = extractEmotion(reply?.content, _emoTagName);

    // <motion> 标签抽取：独立于 emotion，AI 可不改情绪而触发具体动作组（挥手/点头/鞠躬等）。
    //   沿用 emotion 的卫生校验范式（限长 + 字符集白名单），值为 Live2D motion group 名。
    //   支持 <motion>group</motion> 和 <motion name="group"/> 两种写法。
    const _petMotion = extractMotion(reply?.content, _motTagName); // T3b·render 组归位，同上

    // G-1: <orbMessage> 接生产环 — 抽内容广播 orb_message{text} 给前端(悬浮球/陪伴区消费端已就绪 layout:2966)。
    // 仅生产、不影响主回复；广播失败静默。content 仍由展示清洗 strip(:222)。放在去重 guard 之后保证单次广播。
    try {
      const _orbText = extractOrbMessage(reply?.content, _orbTagName); // T3b·render 组归位，同上；标签名可配置(2026-07-09)
      if (_orbText) {
        // 投1: WS → web 前端横幅/toast (已通路, 凛倾拍板=双投)。[0716 T3对接首批] 改经 bus:broadcast.emit 出口。
        const _bcChatIdOrb = args?.chatid || (args?.chat_name ? args.chat_name.replace("common_chat_", "") : "");
        if (_bcChatIdOrb) {
          await dispatch({ target: "bus:broadcast", verb: "emit", source: "yonban", payload: { chatid: _bcChatIdOrb, event: { type: "orb_message", payload: { text: _orbText } } } });
        }
        // 投2 (FT5 A-②): 写 injection_state 入站队列 → desktop-eye 桌面精灵 (无 session, 经 orb-consume 轮询)。
        // 凛倾拍板=双投: web 在聊天页看 toast, 离页时桌面精灵接管; 二者共用同一抽取点, 一处接线双端通车。
        // 捎上 _petEmotion + charName(D-2): 桌宠经 orb-consume 取 {text, emotion, charName} → 表情随聊天同步 + 按当前说话角色卡(charModels)换模型。
        try {
          // T8·回切：原 path.join(__pluginDir,"..","beilu-eye",...) 物理路径指旧壳→改 import.meta.url 相对直指 yonban 新位（旧壳 export * 转发=同一模块实例，缓存/槽位单例语义不变）
          const _orbInjMod = await import(new URL("../../screenshot/injection_state.mjs", import.meta.url).href);
          // B 方案(per-user 隔离): 首参 username(本轮回复所属用户,:427 args.username)→ orb 槽按 user 分区,
          // 桌宠经令牌反解同一 username 才取到,不串台。username 空时 injection_state 落兜底键,旧行为不变。
          if (_orbInjMod.setPendingOrbMessage) _orbInjMod.setPendingOrbMessage(username, _orbText, _petEmotion, charName);
        } catch (_orbInjErr) { /* 入站队列写失败不影响 web 通路 */ }
      }
    } catch (_orbErr) { /* orbMessage 广播失败不影响回复主流程 */ }

    // FT5 A-④: <emotion> 接生产环 — emotion_changed{emotion,charName,chatId,at} 给页外端
    // (Live2D/桌面精灵; web 聊天页不订阅, 页内用纯前端正则切立绘)。命名遵循 broadcast snake_case 同族。失败静默。
    try {
      if (_petEmotion) {
        // [0716 T3对接首批] 改经 bus:broadcast.emit 出口。
        const _bcChatIdEmo = args?.chatid || (args?.chat_name ? args.chat_name.replace("common_chat_", "") : "");
        if (_bcChatIdEmo) {
          await dispatch({ target: "bus:broadcast", verb: "emit", source: "yonban", payload: { chatid: _bcChatIdEmo, event: {
            type: "emotion_changed",
            payload: { emotion: _petEmotion, charName, chatId: _bcChatIdEmo, at: Date.now() },
          } } });
        }
      }
    } catch (_emoErr) { /* emotion_changed 广播失败不影响回复主流程 */ }

    // <motion> 接生产环 — motion_triggered{motion} 给前端 Live2D 渲染器。
    // 沿用 emotion_changed 广播范式：bus:broadcast.emit 出口 + 解析 chatId。失败静默。
    try {
      if (_petMotion) {
        // [0716 T3对接首批] 改经 bus:broadcast.emit 出口。
        const _bcChatIdMot = args?.chatid || (args?.chat_name ? args.chat_name.replace("common_chat_", "") : "");
        if (_bcChatIdMot) {
          await dispatch({ target: "bus:broadcast", verb: "emit", source: "yonban", payload: { chatid: _bcChatIdMot, event: {
            type: "motion_triggered",
            payload: { motion: _petMotion, charName, chatId: _bcChatIdMot, at: Date.now() },
          } } });
        }
      }
    } catch (_motErr) { /* motion_triggered 广播失败不影响回复主流程 */ }

    const _cacheKey = `${username}/${charName}/${_cid || ""}`; // G11：加 chatid 维度，防多窗同角色 tableEdit 去重误判（_cid 定义于 :413）
    const _tableEditHash = computeTableEditHash(reply.content);
    // ★ 修复：tableEdit缓存命中时只跳过tableEdit本身的重复执行
    // 不再直接return — 其他标签（尤其是ideToolCall）仍需处理
    let _skipTableEdit = false;
    if (_tableEditHash) {
      const _lastHash = lastProcessedTableEditHash.get(_cacheKey);
      if (
        _lastHash &&
        _lastHash.hash === _tableEditHash &&
        Date.now() - _lastHash.timestamp < 30000
      ) {
        _skipTableEdit = true;
        opLog("tableEdit", "cache-hit", { hash: _tableEditHash }, "skip");
      }
    }

    let content = reply.content;

    // ★ XML标签容错：修复AI常见的格式错误
    // 1. 简单标签缺少闭合（如 <modeSwitch>code 但没有 </modeSwitch>）
    const _simpleFixTags = ["modeSwitch", "subModeSwitch", "contextClean", "needWebSearch", "presetSwitch", "stopContinue", "chatRename"];
    for (const _tag of _simpleFixTags) {
      // 有开始标签但没有闭合标签 → 尝试补全（取到行尾或下一个<标签前）
      const _openRe = new RegExp(`<${_tag}>([^<]{1,200})(?!<\\/${_tag}>)`, "gi");
      if (_openRe.test(content) && !new RegExp(`</${_tag}>`, "i").test(content)) {
        content = content.replace(
          new RegExp(`<${_tag}>([^<]{1,200})`, "gi"),
          `<${_tag}>$1</${_tag}>`
        );
        diag.warn(`XML容错: 自动补全 <${_tag}> 闭合标签`);
      }
    }
    // 2. 标签名大小写不一致（如 <ModeSwitch> 或 <MODESWITCH>）— 已通过regex /i 标志处理
    // 3. 标签前后多余空格（如 < modeSwitch > 或 < /modeSwitch >）
    content = content.replace(/< \/ ?(\w+) ?>/g, "</$1>");
    content = content.replace(/< (\w+)([ >])/g, "<$1$2");
    wbT(_cid, "memory", "handleReply:xmlFixRewrite", { before: _replyLen, after: content.length });
    reply.content = content;

    // 显示态收尾单源（P0-A 提取，2026-08-03）：提案硬门提前收尾与正常尾步共用同一实现，
    // 防「剥离清单 + 输出管控」两处散写分叉。行为与原尾步逐字等价（strip → W24 输出管控正则）。
    const _composeContentForShow = async () => {
      const baseForShow = reply.content_for_show || reply.content;
      const _customPatterns = await _loadCustomStripPatterns(username);
      // 可配置桌宠标签名(emotionTag/motionTag/orbMessageTag)读同一权威源,剥离跟随配置(白检同 _safeTag,非法丢弃)
      let _petStripTags = [];
      try {
        const _tsm = await import(new URL("../../screenshot/injection_state.mjs", import.meta.url).href);
        const _tss = _tsm.loadPetSettingsStore ? _tsm.loadPetSettingsStore(__projectRoot) : {};
        _petStripTags = [_tss.emotionTag, _tss.motionTag, _tss.orbMessageTag]
          .filter((t) => typeof t === "string" && /^[\w\u4e00-\u9fff-]+$/.test(t));
      } catch { /* 配置不可读:默认名已由字面量剥离覆盖 */ }
      reply.content_for_show = _stripAllTags(baseForShow, _customPatterns, _petStripTags);
      wbT(_cid, "memory", "handleReply:stripAllTags", { before: (baseForShow || "").length, after: (reply.content_for_show || "").length });

      // W24 §三: 输出管控正则 — content_for_show中过滤违规内容
      try {
        const _filterPath = path.join(__projectRoot, "data", "users", username, "output_filter_rules.json");
        if (fs.existsSync(_filterPath)) {
          const _filterRules = JSON.parse(await fs.promises.readFile(_filterPath, "utf-8"));
          const _rules = (_filterRules.rules || []).filter(r => r.enabled);
          let _violations = [];
          for (const rule of _rules) {
            try {
              const regex = new RegExp(rule.pattern, "gi");
              if (regex.test(reply.content_for_show)) {
                reply.content_for_show = reply.content_for_show.replace(regex, rule.replacement || "[已过滤]");
                if (rule.warn_ai) {
                  _violations.push({ name: rule.name, message: rule.warn_message || rule.name });
                }
              }
            } catch (_reErr) {
              console.warn(`[beilu-memory] 输出管控: 规则"${rule.name}"正则错误:`, _reErr.message);
            }
          }
          // 存储违规记录供下轮GetPrompt注入警告
          if (_violations.length > 0) {
            const _warningPath = path.join(__projectRoot, "data", "users", username, "_output_filter_violations.json");
            nicerWriteFileSync(_warningPath, JSON.stringify(_violations, null, 2));
          }
        }
      } catch (_filterErr) {
        wbD(_cid, "memory", "handleReply:outputFilter", false, _filterErr.message, {});
        console.warn("[beilu-memory] 输出管控检查失败:", _filterErr.message);
      }
      // 陪伴历史/终态与流式气泡使用同一个纯正文投影；写入 extension 后刷新/重启仍不必让
      // 前端重新发明一份标签清理规则。思维链和操作内容不进入该字段。
      reply.extension ??= {};
      reply.extension._companion_visible_text = projectCompanionVisibleText(reply.content_for_show, username, _petStripTags);
    };

    // ★ W66优化：预提取所有操作标签（防止嵌套/顺序导致匹配丢失）
    // 先从原始 content 中提取，再在后续步骤中清理
    const _preExtracted = {};
    // needWebSearch（支持嵌套在其他标签内）
    // [0717 多查询修] AI 自然会发多个 <searchKeyword>（0716 PPT 任务实证发了 2 个），原实现只取
    //   第一个、其余静默丢弃（教学↔执行契约断裂）。改为全量收集（上限 3 防滥用），执行段逐条查合并。
    const _preNws = content.match(/<needWebSearch>([\s\S]*?)<\/needWebSearch>/i);
    if (_preNws) {
      const _kwAll = [..._preNws[1].matchAll(/<searchKeyword>([\s\S]*?)<\/searchKeyword>/gi)]
        .map((m) => m[1].trim()).filter(Boolean);
      if (_kwAll.length > 0) _preExtracted.webSearchQueries = _kwAll.slice(0, 3);
      else {
        const _q = _preNws[1].trim();
        if (_q) _preExtracted.webSearchQueries = [_q];
      }
    }
    // 分身标签（支持嵌套）
    // [0726 五修#1 续接链解析根修] 原 regex 只认 clone="..."：AI 按系统续接提示写 resumeTaskId 属性时
    //   整体匹配失败=任务静默不派发+标签泄漏进可见回复（:3466 载回分支因此从未可达）。现属性串整体
    //   捕获再逐个提取，兼容 clone="名" / resumeTaskId=5 / resumeTaskId="5" 任意顺序与未知属性。
    const _preCloneRegex = /<分身(\d+)((?:\s+[a-zA-Z_]+\s*=\s*(?:"[^"]*"|[^\s">]+))*)\s*>([\s\S]*?)<\/分身\1>/gi;
    let _preCloneMatch;
    const _preCloneTasks = [];
    while ((_preCloneMatch = _preCloneRegex.exec(content)) !== null) {
      const _pcAttrs = _preCloneMatch[2] || "";
      const _pcClone = _pcAttrs.match(/clone\s*=\s*"([^"]*)"/i)?.[1] ?? _pcAttrs.match(/clone\s*=\s*([^\s">]+)/i)?.[1] ?? "";
      const _pcResume = _pcAttrs.match(/resumeTaskId\s*=\s*"?(\d+)"?/i)?.[1];
      const _pcResumeJob = _pcAttrs.match(/resumeJobId\s*=\s*"([^"]+)"/i)?.[1] ?? _pcAttrs.match(/resumeJobId\s*=\s*([^\s">]+)/i)?.[1];
      const _pcTask = { id: parseInt(_preCloneMatch[1]), cloneName: _pcClone, instruction: _preCloneMatch[3].trim() };
      if (_pcResume) _pcTask.resumeTaskId = parseInt(_pcResume);
      if (_pcResumeJob) _pcTask.resumeJobId = _pcResumeJob;
      _preCloneTasks.push(_pcTask);
    }
    if (_preCloneTasks.length > 0) _preExtracted.cloneTasks = _preCloneTasks;
    // presetSwitch
    const _prePsMatch = content.match(/<presetSwitch>([\s\S]*?)<\/presetSwitch>/i);
    if (_prePsMatch) {
      _preExtracted.presetSwitch = _prePsMatch[1].trim();
    }
    // stopContinue — 排除反引号内的代码引用（AI提到标签名不应触发）
    const _scTestContent = content.replace(/`[^`]*`/g, "").replace(/```[\s\S]*?```/g, "");
    if (/<stopContinue\s*\/?>/.test(_scTestContent)) _preExtracted.stopContinue = true;

    // ═══════════════════════════════════════════════════════════════
    // P0-A Smart 提案硬门（2026-08-03 全智能确认收口；Fable 审查阻断1/2/6 根修）
    // why：Smart/Chat → Code/Work 的 <modeSwitch> 是【提案】不是执行。旧链在用户确认前就写
    //   status:"running" 的角色级 work/_active_task_overlay.json（多任务互覆），且同回复的
    //   tableEdit/ideToolCall/delegate/分身等可变标签照常执行——「确认」从未成为服务端状态。
    //   根因层=ReplyHandler 缺统一 admission gate：提案轮必须整体拒绝可变操作，不是逐标签拦截。
    // 行为（检测到投递语义 modeSwitch：chat|smart → code|work；Bot L<3 沿用既有档位闸不产提案）：
    //   1. confirmationStore.createPendingConfirmation 建 per-owner 持久化 pending 记录（非 running）；
    //   2. 本轮全部可变标签一律不执行（提前收尾：只做显示剥离+去重标记，回复正文照常落盘展示）；
    //   3. 不入任何 pendingResults 池（防触发自动续轮）；generation 按 _pendingConfirmation 硬停续轮/loop；
    //   4. extension._pendingConfirmation 投影给前端确认卡；确认/取消/状态走 endpoints
    //      smart-confirmations 认证端点（session owner + 单次 claim），不走前端事件。
    //   提案登记失败=fail-closed：本轮同样不执行任何可变操作（extension._pendingConfirmationError
    //   透出真实错误给前端），绝不回退到「无门执行」。
    // ═══════════════════════════════════════════════════════════════
    let _proposalGate = false;
    let _smartProposal = null;
    let _smartProposalError = "";
    {
      const _propMatch = content.match(/<modeSwitch>(chat|code|work)<\/modeSwitch>/i);
      if (_propMatch) {
        const _propTarget = _propMatch[1].toLowerCase();
        const _propCur = resolveGenerationMode(args, username, charName, _cid);
        const _propDelivery = (_propCur === "chat" || _propCur === "smart") && (_propTarget === "code" || _propTarget === "work");
        if (_propDelivery && !(botPerm && botPerm.level < 3)) {
          _proposalGate = true;
          try {
            const _confStorePath = path.join(__pluginDir, "..", "..", "shells", "beilu-chat", "src", "lib", "confirmationStore.mjs");
            const _confStore = await import(pathToFileURL(_confStorePath).href);
            const _cleanReplyTitle = (reply.content || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
            const _propRec = _confStore.createPendingConfirmation({
              ownerUsername: username,
              sourceChatId: _cid || "",
              sourceCharName: charName === "_global" ? (args?.char_name || charName) : charName,
              sourceMode: _propCur,
              sourceMessageId: (typeof args?.reply_message_id === "string" && args.reply_message_id) || (typeof reply?.id === "string" ? reply.id : ""),
              targetMode: _propTarget,
              taskTitle: _cleanReplyTitle.substring(0, 80) || `${_propTarget}模式任务`,
              deferredTags: _tagSummary,
            });
            _smartProposal = _confStore.projectConfirmation(_propRec);
          } catch (_propErr) {
            _smartProposalError = _propErr?.message || String(_propErr);
            wbD(_cid, "memory", "handleReply:smartProposal:createFail", false, _smartProposalError, { target: _propTarget });
            console.error(`[beilu-memory] Smart 提案登记失败（fail-closed：本轮可变操作仍全部拒绝）: ${_smartProposalError}`);
          }
        }
      }
    }
    if (_proposalGate) {
      if (_smartProposal) {
        reply.extension._pendingConfirmation = _smartProposal;
        opLog("modeSwitch", `proposal ${_smartProposal.sourceMode}→${_smartProposal.targetMode}`, { confirmationId: _smartProposal.confirmationId, deferredTags: _tagSummary }, "ok");
        wbT(_cid, "memory", "handleReply:smartProposal", { confirmationId: _smartProposal.confirmationId, deferred: _tagSummary });
      } else {
        reply.extension._pendingConfirmationError = _smartProposalError || "提案登记失败";
        opLog("modeSwitch", "proposal_create_fail", { error: _smartProposalError }, "fail");
      }
      // 提前收尾：不进任何副作用段（tableEdit/归档/搜索/热层写/ideToolCall/委派/分身/调度/清理…），
      // 不跑 autoCheckArchiveTriggers（会触发 P2 归档 AI）。显示剥离与输出管控走同一单源。
      await _composeContentForShow();
      reply._memory_tags_processed = true;
      wbT(_cid, "memory", "handleReply:exit", { pendingConfirmation: true });
      return false;
    }

    // 0b. <vocab_edit>（P9 词库维护，0731 子模式化）：P9 作为聊天组子模式走正常对话链，
    //   执行层与 P 系列执行器共享 vocabEditExec 单点（preview→confirm 两态，pending 模块级跨请求）。
    //   标签**不清理**：AI 下一轮必须能看到自己发过的标签原文才能原样重发 confirm:true（清理=确认流物理断裂）；
    //   代码零文案进对话（0731 铁律）——执行状态只进白盒，用户可见反馈由 P9 提示词（用户域）教 AI 在正文自述。
    //   独立 try：词库失败不影响表格等后续段。
    try {
      const { blocks: _veBlocks } = parseVocabEditTags(content);
      if (_veBlocks.length > 0 && _admit("vocabEdit", `×${_veBlocks.length}`)) {
        const _veResults = await executeVocabEditOps(_veBlocks, { username: args?.username || "" });
        wbT(_cid, "memory", "handleReply:vocabEdit", { blocks: _veBlocks.length, results: _veResults.map((r) => ({ status: r.status, file: r.file, total: r.total })) });
      }
    } catch (e) {
      wbD(_cid, "memory", "handleReply:vocabEdit", false, e.message, {});
      console.warn("[beilu-memory] vocab_edit 执行失败:", e.message);
    }

    // 1. <tableEdit>
    // [0730 框架修] try/catch 保护：saveTablesData/executeTableOperations 无内层保护，抛异常会跳到顶层 catch 跳过 section 7（ideToolCall）。
    try {
    const { operations, cleanContent: afterTableEdit } = parseTableEditTags(content);
    content = afterTableEdit;
    // ★ 缓存命中时跳过表格操作（防重复执行），但标签仍然被清理
    if (operations.length > 0 && !_skipTableEdit && _admit("tableEdit", `ops×${operations.length}`)) {
      // [A4] tableEdit 前自动快照
      try {
        const { chatId: _chatId, messageIndex: _msgIndex, messageId: _msgId } = await _getReplyCoordinates();
        const _snapData = loadMemoryData(username, charName, undefined, _cid);
        createTableSnapshot(username, charName, _snapData.tables, _chatId, _msgIndex, "tableEdit前自动快照", _snapData.activeMode, _msgId);
      } catch (e) {
        wbD(_cid, "memory", "handleReply:tableEditSnapshot", false, e.message, {});
        console.warn("[beilu-memory] A4 tableEdit 快照失败:", e.message);
      }
      // [2026-07-16 凛倾「可以加」] archiveRows 分流：AI 正规归档指令不进内存 CRUD 引擎
      //   （executeTableOperations 无此 case=静默吞），走 archiveTableRowsGeneric（热层单源
      //   hot/archive/tables/<mode>/ + F2 去重 + 可恢复，与设置弹窗/自动归档同一条链）。
      //   执行顺序=CRUD 先、归档后（归档引擎自 load 缓存同对象拿到 CRUD 后最新态；教学侧已注明
      //   同一回复对同一表勿混用 deleteRow+archiveRows 防索引漂移）。
      const _arcOps = operations.filter((o) => o.type === "archiveRows");
      const _crudOps = operations.filter((o) => o.type !== "archiveRows");
      const data = loadMemoryData(username, charName, undefined, _cid);
      const { successCount, failures: _teFailures } = executeTableOperations(data.tables, _crudOps);
      if (successCount > 0) {
        for (const _op of _crudOps) {
          // 修7（20260716）：取表统一 parseOperationArgs（与 :966 晋升链同源）——原裸正则抓 rawArgs
          //   首个数字≠tableIndex（字段顺序不定时抓错表=rev 记错表），且与真实执行 tableEngine 解析双源。
          const _pa = parseOperationArgs(_op.type, _op.rawArgs);
          const _ti = _pa?.tableIndex;
          const _tgt = _ti != null ? data.tables.find((t) => t.id === Number(_ti)) || data.tables[Number(_ti)] : null;
          if (_tgt) _tgt.rev = (Number(_tgt.rev) || 0) + 1;
        }
        // H7：tableEdit 写盘从 fire-and-forget 改为 await，写失败时 wbD 记录（原 fire-and-forget 静默丢失）
        const _teWrite = await saveTablesData(username, charName, data.activeMode, _cid);
        if (_teWrite && _teWrite.ok === false) wbD(_cid, "memory", "handleReply:tableEdit:writeFail", false, _teWrite.error, {});
        // ②T1 记忆晋升：经验类表新插入条目 → 晋升 _global 跨角色复用。
        // 钩在 insert 而非归档：code/work 归档流为 vapor（triggerP2CodeArchive 不存在 / autoCheckArchiveTriggers 仅 chat），
        // 经验"被记录"即"值得共享"，语义更顺。关系/画像表不在 isPromotable 白名单 → 结构上进不来（人格隔离）。
        try {
          const _promoMode = resolveGenerationMode(args, username, charName, _cid);
          // operations 元素是 { type, rawArgs }（parseTableEditTags），tableIndex 在 rawArgs 里，须 parseOperationArgs 解。
          for (const _op of _crudOps) {
            if (_op.type !== "insertRow") continue;
            const _pa = parseOperationArgs(_op.type, _op.rawArgs);
            if (!_pa || !isPromotable(_promoMode, _pa.tableIndex)) continue;
            const _ptbl = data.tables.find((t) => t.id === _pa.tableIndex) || data.tables[_pa.tableIndex];
            const _prow = _ptbl && _ptbl.rows.length ? _ptbl.rows[_ptbl.rows.length - 1] : null;
            if (_prow) promoteToGlobal(username, _promoMode, _pa.tableIndex, _ptbl.columns, _prow, charName);
          }
        } catch (_promoErr) {
          console.warn("[beilu-memory] 记忆晋升 _global 失败:", _promoErr.message);
        }
      }
      // archiveRows 执行（CRUD 落盘后）：逐 op 走热层归档引擎。失败与 CRUD 同池回喂 AI 自纠。
      let _arcOkCount = 0;
      for (const _op of _arcOps) {
        const _pa = parseOperationArgs(_op.type, _op.rawArgs);
        if (!_pa || !Array.isArray(_pa.rowIndices) || _pa.rowIndices.length === 0) {
          _teFailures.push({ op: `archiveRows(${String(_op.rawArgs ?? "").slice(0, 60)})`, reason: "参数无法解析（格式：archiveRows(表格编号, 行编号, 行编号...)）" });
          continue;
        }
        try {
          const _ar = await archiveTableRowsGeneric(username, charName, data.activeMode, _pa.tableIndex, _cid, { rowIndices: _pa.rowIndices });
          if (_ar.archived > 0) _arcOkCount++;
          else _teFailures.push({ op: `archiveRows(${String(_op.rawArgs ?? "").slice(0, 60)})`, reason: `未归档任何行（表 #${_pa.tableIndex} 现有 ${_ar.remaining} 行，行号越界？）` });
        } catch (_arcErr) {
          wbD(_cid, "memory", "handleReply:archiveRows", false, _arcErr.message, { tableIndex: _pa.tableIndex });
          _teFailures.push({ op: `archiveRows(${String(_op.rawArgs ?? "").slice(0, 60)})`, reason: `归档失败: ${_arcErr.message}` });
        }
      }
      if (_arcOps.length > 0) opLog("tableEdit", `archiveRows ${_arcOkCount}/${_arcOps.length}`, { ops: _arcOps.map(o => `archiveRows(${parseOperationArgs(o.type, o.rawArgs)?.tableIndex ?? "?"})`).slice(0, 10) }, _arcOkCount > 0 ? "ok" : "fail");
      // 修7（20260716）：原 o.action/o.tableIndex/o.rowIndex 是 operations 上不存在的字段（真形状={type,rawArgs}），日志恒 undefined(undefined,)
      opLog("tableEdit", `exec ${successCount}/${_crudOps.length}`, { ops: _crudOps.map(o => `${o.type}(${parseOperationArgs(o.type, o.rawArgs)?.tableIndex ?? "?"})`).slice(0, 10) }, successCount > 0 ? "ok" : "fail");
      // 断点#5 修（0716）：失败明细喂回 AI——原失败只进日志，AI 以为写成功无法自纠（IDE/联网链均有失败回喂，本链原单向断裂）。
      // 同 pendingChatSearchResults 范式：下一轮 GetPrompt 注入纯事实呈现后清除。
      if (_teFailures.length > 0) {
        pendingTableEditFeedback.set(`${username}/${charName}/${_cid || "_"}`, {
          failures: _teFailures.slice(0, 10),
          timestamp: new Date().toISOString().slice(0, 16).replace("T", " "),
        });
      }
      if (_tableEditHash) {
        lastProcessedTableEditHash.set(_cacheKey, { hash: _tableEditHash, timestamp: Date.now() });
      }
    } else if (operations.length > 0 && _skipTableEdit) {
    }
    } catch (_teErr) { wbD(_cid, "memory", "handleReply:tableEdit", false, _teErr.message, {}); console.warn("[beilu-memory] tableEdit 处理失败:", _teErr.message); }

    // 1b. <taskPlan> / <taskCheck> — F3「AI 制定任务 + 打勾」（G2 新范式）
    // 与 tableEdit 同范式：从 content 提取标签 → 改 work_ctx/tasks.json（单一权威，不进 chat log/tables）
    // → 对 AI 剥标签（_stripAllTags 已加 taskPlan/taskCheck）→ 结果进 reply.extension（G8 对用户折叠）。
    // 数据按 _activeMode + _cid 隔离（taskStore.resolveTasksPath 内部按 K5 seam 下沉）。
    try {
      const _taskMode = resolveGenerationMode(args, username, charName, _cid);
      let _taskChanged = false;
      let _taskStore = null;

      // <taskPlan>：JSON 数组 或 行清单 → 全量替换 tasks
      const _tpMatch = content.match(/<taskPlan>([\s\S]*?)<\/taskPlan>/i);
      if (_tpMatch && _admit("taskPlan", "")) {
        const _rawTasks = _parseTaskPlanBody(_tpMatch[1]);
        _taskStore = await applyTaskPlan(username, charName, _taskMode, _cid, _rawTasks);
        _taskChanged = true;
        reply.extension._taskPlan = {
          count: _taskStore.tasks.length,
          remaining: remainingCount(_taskStore),
          rev: _taskStore.rev,
        };
        opLog("taskPlan", `set ${_taskStore.tasks.length}项`, { remaining: remainingCount(_taskStore) }, "ok");
        content = content.replace(/<taskPlan>[\s\S]*?<\/taskPlan>/gi, "");
      }

      // <taskCheck>：按 id 或 content 勾掉一项（status=completed）。支持自闭合属性式与块式。
      // <taskCheck id="t123"/> | <taskCheck content="..."/> | <taskCheck>整句任务内容</taskCheck>
      const _tcSelectors = _parseTaskCheckBody(content);
      const _tcAdmitted = _tcSelectors.length === 0 || _admit("taskCheck", `×${_tcSelectors.length}`);
      for (const _sel of (_tcAdmitted ? _tcSelectors : [])) {
        const _res = await applyTaskCheck(username, charName, _taskMode, _cid, _sel);
        if (_res.matched) {
          _taskStore = _res.store;
          _taskChanged = true;
          opLog("taskCheck", "done", { sel: _sel.id || _sel.content || "", remaining: remainingCount(_res.store) }, "ok");
        } else {
          opLog("taskCheck", "miss", { sel: _sel.id || _sel.content || "" }, "fail");
        }
      }
      if (_tcSelectors.length > 0) {
        content = content.replace(/<taskCheck\s[^>]*?\/>|<taskCheck>[\s\S]*?<\/taskCheck>/gi, "");
        if (_taskStore) {
          reply.extension._taskCheck = {
            remaining: remainingCount(_taskStore),
            rev: _taskStore.rev,
          };
        }
      }

      // 任务变更 → broadcastAllChatUi 家族推送（推送优先轮询，不变式4）。
      // 本窗口 broadcastChatEvent + 跨窗口 broadcastCrossChatEvent（全智能监听另一窗口任务态）。
      if (_taskChanged && _cid) {
        try {
          // [0716 T3对接首批] 双投改经 bus:broadcast 出口（emit=本窗口 / emitCross=跨窗口）。
          const _finalStore = _taskStore || loadTasks(username, charName, _taskMode, _cid);
          const _taskPayload = {
            chatid: _cid,
            tasks: _finalStore.tasks,
            rev: _finalStore.rev,
            remaining: remainingCount(_finalStore),
          };
          await dispatch({ target: "bus:broadcast", verb: "emit", source: "yonban", payload: { chatid: _cid, event: { type: "task_update", payload: _taskPayload } } });
          await dispatch({ target: "bus:broadcast", verb: "emitCross", source: "yonban", payload: { chatid: _cid, event: { type: "cross_mode_task_update", subtype: "tasks", payload: _taskPayload } } });
        } catch (_bcErrT) { /* 广播失败不影响主回复，前端轮询兜底 */ }
      }
    } catch (_taskErr) {
      wbD(_cid, "memory", "handleReply:taskPlanCheck", false, _taskErr.message, {});
      console.warn("[beilu-memory] taskPlan/taskCheck 处理失败:", _taskErr.message);
    }

    // 2. <memoryArchive>
    // [0730 框架修] try/catch 保护：H7 改 await 后 saveTablesData 可抛，无保护会跳到顶层 catch 跳过 section 7（ideToolCall）。
    try {
    const { archiveOps, cleanContent: afterArchive } = parseMemoryArchiveTags(content);
    content = afterArchive;
    if (archiveOps.length > 0 && _admit("memoryArchive", `ops×${archiveOps.length}`)) {
      const replyMemData = loadMemoryData(username, charName, undefined, _cid);
      try {
        const { chatId: _maChatId, messageIndex: _maMsgIndex, messageId: _maMsgId } = await _getReplyCoordinates();
        createTableSnapshot(username, charName, replyMemData.tables, _maChatId, _maMsgIndex, "memoryArchive 前自动快照", replyMemData.activeMode, _maMsgId);
      }
      catch (_maSnapErr) { wbD(_cid, "memory", "handleReply:memArchiveSnapshot", false, _maSnapErr.message, {}); }
      const archiveResults = executeMemoryArchiveOps(archiveOps, username, charName, replyMemData.tables);
      const archiveOkCount = archiveResults.filter((r) => r.status === "ok").length;
      if (archiveOkCount > 0) {
        const _maWrite = await saveTablesData(username, charName, replyMemData.activeMode, _cid);
        if (_maWrite && _maWrite.ok === false) wbD(_cid, "memory", "handleReply:memArchive:writeFail", false, _maWrite.error, {});
      }
      opLog("memoryArchive", `exec ${archiveOkCount}/${archiveResults.length}`, { ops: archiveOps.map(o => o.action || o.type).slice(0, 10) }, archiveOkCount > 0 ? "ok" : "fail");
    }
    } catch (_maErr) { wbD(_cid, "memory", "handleReply:memoryArchive", false, _maErr.message, {}); console.warn("[beilu-memory] memoryArchive 处理失败:", _maErr.message); }

    // 3. <memorySearch>
    const { searchOps: chatSearchOps, cleanContent: afterSearch } = parseMemorySearchTags(content);
    content = afterSearch;
    if (chatSearchOps.length > 0 && _admit("memorySearch", `ops×${chatSearchOps.length}`)) {
      try {
        const chatSearchResults = await executeMemorySearchOps(chatSearchOps, username, charName); // async 化（0722 向量 fallback 接入）
        // [0728 top-k] 记召回频率：结果缓存进 pendingChatSearchResults 下轮必注入，执行点=记录点
        recordRecall(getMemoryDir(username, charName), collectTouchedFiles(chatSearchResults));
        const formattedResults = formatSearchResultsForAI(chatSearchResults);
        if (formattedResults && formattedResults !== "(无搜索结果)") {
          // 功能槽 memory：与联网搜索的 web 槽并存（架构「a 和 b 同时激活工作两次不影响」）
          pendingChatSearchResults.set(chatSearchSlotKey(username, charName, _cid, "memory"), {
            results: formattedResults,
            timestamp: new Date().toISOString(),
          });
          opLog("memorySearch", `exec ${chatSearchOps.length}`, { resultLen: formattedResults.length }, "ok");
        } else {
          opLog("memorySearch", `exec ${chatSearchOps.length}`, { result: "empty" }, "ok");
        }
      } catch (e) {
        wbD(_cid, "memory", "handleReply:memorySearch", false, e.message, {});
        console.warn(`[beilu-memory] ReplyHandler: 聊天AI搜索执行失败:`, e.message);
        opLog("memorySearch", "fail", { error: e.message }, "fail");
      }
    }

    // 3b. <needWebSearch> — 聊天AI直接请求联网搜索（使用预提取数据；0717 起多 searchKeyword 逐条查合并回喂）
    const _searchQueries = _preExtracted.webSearchQueries || [];
    if (_searchQueries.length > 0 && _admit("needWebSearch", `×${_searchQueries.length}`)) {
      const _memData = loadMemoryData(username, charName);
      const _wsConfig = _memData.config?.web_search || {};
      // P8开启或web_search.enabled不为false均可搜索
      const _presetsForWs = loadMemoryPresets(username, charName);
      const _p8ForWs = _presetsForWs.presets?.find(p => p.id === "P8");
      if (_wsConfig.enabled !== false || (_p8ForWs && _p8ForWs.enabled)) {
        const _wsBlocks = [];
        const _wsEvents = []; // [0717 前端搜索卡] 结构化事件挂 reply.extension（_taskPlan 同款落盘+广播链）
        const _wsDomainOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
        for (const _searchQuery of _searchQueries) {
          try {
            const _searchResult = await executeWebSearch(_searchQuery, _wsConfig);
            if (_searchResult.results && _searchResult.results.length > 0) {
              // [0726 警示消费] warning=成功但可疑度中等（结果照给，提醒 AI/用户自判）——纯事实呈现非引导句
              const _wsWarnLine = _searchResult.warning ? `\n⚠️ ${_searchResult.warning}` : "";
              // 传导层只负责块头（查询/引擎/警示=本系统文案）；结果文本的格式、相关度、安全边界
              //   由功能层 buildInjectableSearchText 单源产出（原本处自写编号格式=功能散写，已收口）
              const _formatted = buildInjectableSearchText(_searchResult.results, "聊天AI联网搜索");
              _wsBlocks.push(`[聊天AI联网搜索结果 (${_searchResult.engine})]\n查询: ${_searchQuery}${_wsWarnLine}\n${_formatted}\n[/聊天AI联网搜索结果]`);
              _wsEvents.push({
                query: _searchQuery, engine: _searchResult.engine, count: _searchResult.results.length,
                warning: _searchResult.warning || undefined, // 前端搜索卡可显（未消费=不显，无破坏）
                results: _searchResult.results.map((r) => ({ title: r.title || "", url: r.url || "", domain: _wsDomainOf(r.url || "") })),
              });
              opLog("webSearch", `"${_searchQuery}"`, { count: _searchResult.results.length, engine: _searchResult.engine }, "ok");
            } else {
              // 错误可见（诊断面原则）：失败/空结果也回喂 AI，静默吞错会让"搜索失败"表现成"AI 没搜"。
              // [0717 链2 修] 被滤条目摘要一并回喂（纯事实呈现）：只报"无结果"会把引擎投毒/过滤全灭
              //   （no_match/self_link/domain_cap N 条）这一确诊信息折叠掉，AI 与用户无从得知真因。
              const _wsDropped = Array.isArray(_searchResult.noise_dropped) ? _searchResult.noise_dropped : [];
              const _wsDropLine = _wsDropped.length > 0
                ? `\n被过滤: ${_wsDropped.length} 条（${[..._wsDropped.reduce((m, d) => m.set(d.flag, (m.get(d.flag) || 0) + 1), new Map())].map(([f, n]) => `${f}×${n}`).join(", ")}）`
                : "";
              _wsBlocks.push(`[聊天AI联网搜索失败 (${_searchResult.engine})]\n查询: ${_searchQuery}\n原因: ${_searchResult.error || "无结果"}${_wsDropLine}\n[/聊天AI联网搜索失败]`);
              _wsEvents.push({ query: _searchQuery, engine: _searchResult.engine, count: 0, error: _searchResult.error || "无结果", results: [] });
              opLog("webSearch", `"${_searchQuery}"`, { engine: _searchResult.engine, error: _searchResult.error || "无结果", dropped: _wsDropped.length }, "fail");
            }
          } catch (e) {
            wbD(_cid, "memory", "handleReply:webSearch", false, e.message, { query: _searchQuery });
            console.warn(`[beilu-memory] ReplyHandler: 聊天AI联网搜索失败:`, e.message);
            _wsBlocks.push(`[聊天AI联网搜索失败]\n查询: ${_searchQuery}\n原因: ${e.message}\n[/聊天AI联网搜索失败]`);
            _wsEvents.push({ query: _searchQuery, count: 0, error: e.message, results: [] });
            opLog("webSearch", `"${_searchQuery}"`, { error: e.message }, "fail");
          }
        }
        if (_wsBlocks.length > 0 && _wsConfig.inject_once === true) {
          // [0726 002「用户只选择开启p8还有是否单次注入」] 单次注入：结果**不进对话历史**，
          //   走瞬态通道（GetPrompt 一次性 get+delete 后即消失，见 getPromptHandler:1622）。
          //   why 复用旧通道而不是新造"落盘后再删"：该通道读侧一直健在（0726 改道时只停了写侧），
          //   语义正是"注入一次即散"，且包装模板在 INJ-chat-search-data 用户可改——零新机制。
          //   适用场景：一次性查证，不希望搜索结果长期占用上下文预算。
          // 功能槽 web：与记忆检索的 memory 槽并存。
          //   ⚠ key 用 _cid 而非 _qcid——读侧（getPromptHandler）按 `${_cid || "_"}` 定位，
          //   而 _qcid 在无 chatid 时是随机串 __noChat_xxx（:743），用它写入 = 永不匹配且无报错。
          //   槽维度由 chatSearchSlotKey 单源构造，写/读/清三侧共用同一份格式。
          pendingChatSearchResults.set(chatSearchSlotKey(username, charName, _cid, "web"), {
            timestamp: new Date().toISOString(),
            results: _wsBlocks.join("\n\n"),
          });
          opLog("webSearch", "inject_once", { queries: _searchQueries.length, mode: "瞬态注入" }, "ok");
        } else if (_wsBlocks.length > 0) {
          // [0726 002拍板「搜索内容需要注入的是对话尾部,当成对话,也就是说系统注入,和ai指令一样」]
          //   改道 pendingResults 收口：原走 pendingChatSearchResults → GetPrompt 瞬态注入块（一次性
          //   get+delete、零 chatLog 留痕——「AI 误判未注入」确诊土壤）。现与 ideToolCall/分身结果同通道：
          //   回合末分支③/前置落地落 chatLog system 条（对话尾部、落盘可回看），续轮+max_rounds 熔断全套继承；
          //   worker 路由走 runner 跨界队列（与 ideToolCall 同路），旧通道的 worker 特判不再需要。
          //   旧通道（pendingChatSearchResults/INJ-chat-search-data/generation web_search 池 peek）停写后
          //   读侧空转无害，清理列待办不在本批。regen 重跑链的重复入队窗口极小（回合末必消费），可辨不致害。
          ideClient.enqueuePendingResult({
            tool: "_web_search_results",
            // params.query：前端工具卡卡头主语（generation._buildIdeToolEvents 读 params.query），
            //   多查询用 " | " 连接——无此字段卡头只有裸 tool 名（0726 四链审计发现）
            params: { query: _searchQueries.join(" | "), queries: _searchQueries.length },
            result: { success: true, result: _wsBlocks.join("\n\n") },
            chatid: _qcid,
            timestamp: new Date().toISOString(),
          });
        }
        if (_wsEvents.length > 0) {
          // [0717 时序免疫] 同键双 producer（本处 + beilu-web <search>）且 ReplyHandler 链按插件注册序、
          // regen 会重跑整链而 extension 跨轮残留——整体赋值会按链序覆盖对方事件、盲追加会在 regen
          // 轮累积重复。语义收口：追加 + 按 query 去重（新事件顶替同 query 旧事件，跨 producer 保留）。
          if (!reply.extension) reply.extension = {};
          const _prevWsEvts = Array.isArray(reply.extension._webSearchEvents) ? reply.extension._webSearchEvents : [];
          reply.extension._webSearchEvents = [
            ..._prevWsEvts.filter((e) => !_wsEvents.some((n) => n.query === e.query)),
            ..._wsEvents,
          ]; // 前端 _appendWebSearchCard 消费（用户可见搜索卡）
        }
      } else {
        // [0717 诊断面补齐·002问题清单#4①] 门控拒绝（web_search.enabled 显式 false 且 P8 关）原走空分支
        //   零回喂零留痕：AI 发了 <needWebSearch> 标签被 :1211 清掉后，AI 下一轮不知道搜索被拒（编造温床）、
        //   用户零呈现。对齐 :1179 失败块诊断面原则（静默吞错会让"搜索被拒"表现成"AI 没搜"）：
        //   回喂块+opLog+事件卡三件套同构补齐，文案=事实呈现（配置状态），非引导句。
        const _wsDeniedReason = "联网搜索开关已关闭（web_search.enabled=false 且 P8 未启用）";
        const _wsDeniedBlocks = _searchQueries.map((q) => `[聊天AI联网搜索未执行]\n查询: ${q}\n原因: ${_wsDeniedReason}\n[/聊天AI联网搜索未执行]`);
        // [0726 同批改道] 拒绝信息与结果同通道落对话尾部 system 条（事实呈现非失败，success:true 防"❌失败"前缀）
        ideClient.enqueuePendingResult({
          tool: "_web_search_results",
          params: { query: _searchQueries.join(" | "), queries: _searchQueries.length, denied: true },
          result: { success: true, result: _wsDeniedBlocks.join("\n\n") },
          chatid: _qcid,
          timestamp: new Date().toISOString(),
        });
        const _wsDeniedEvents = _searchQueries.map((q) => ({ query: q, count: 0, error: _wsDeniedReason, results: [] }));
        if (!reply.extension) reply.extension = {};
        const _prevDeniedEvts = Array.isArray(reply.extension._webSearchEvents) ? reply.extension._webSearchEvents : [];
        reply.extension._webSearchEvents = [
          ..._prevDeniedEvts.filter((e) => !_wsDeniedEvents.some((n) => n.query === e.query)),
          ..._wsDeniedEvents,
        ];
        for (const q of _searchQueries) opLog("webSearch", `"${q}"`, { denied: true, reason: "gate_disabled" }, "fail");
      }
    }
    content = content.replace(/<needWebSearch>[\s\S]*?<\/needWebSearch>/gi, "");

    // 4. <memoryNote>（T5-4：解析层只返回 notes，落盘走 storage.appendPendingTasks 收口）
    {
      const { notes: _mnNotes, cleanContent: _mnClean } = parseMemoryNoteTags(content);
      content = _mnClean;
      try {
        if (_mnNotes.length === 0 || _admit("memoryNote", `×${_mnNotes.length}`)) await appendPendingTasks(username, charName, _mnNotes);
      }
      catch (e) { console.error("[beilu-memory] 保存 memoryNote 失败:", e.message); }
    }

    // ★ active_project producer（2026-07-16 断链根修）：active_project 全库原本零写点（20260605 审计
    //   已判"无设置机制"，storage.mjs ensureCodeMemoryDirs 首装恒空串）→ 下游整条链从未运行：
    //   route 埋点(_routeTask 恒空)→警告→回流注入、getDataHandler 快照(恒"无活动任务/线路0条")、
    //   addRouteNote/ackDataWarning(恒报无活动任务)、{{active_project}} 宏(getPromptHandler/aiRunner/preset 三处恒空)。
    //   收口位=AI 建任务 md 的唯一"任务开始"事实点（codeMemoryWrite/workMemoryWrite 写成功后）：
    //   active/{任务}.md 与 route 的 {任务}.route.jsonl 同名域配对，任务名=文件名去 .md；
    //   语义=最近写的任务文件即当前活动任务。存放沿用既有单点 code/_code_config.json
    //   （PJ-2 审计：work 模式 _routeTask 也读此处，active_project 为跨模式单源），同值幂等不写盘。
    const _setActiveProject = (safeFilename) => {
      try {
        const _task = safeFilename.replace(/\.md$/i, "").trim();
        if (!_task) return;
        const _ccPath = getCodeConfigPath(username, charName);
        const _cc = loadJsonFileIfExists(_ccPath, {});
        if (_cc.active_project === _task) return;
        _cc.active_project = _task;
        saveJsonFile(_ccPath, _cc);
        opLog("activeProject", _task, { source: "memoryWrite" }, "ok");
      } catch (e) {
        wbD(_cid, "memory", "handleReply:setActiveProject", false, e.message, { file: safeFilename });
      }
    };

    // 5. <codeMemoryWrite> — AI写入热层md文件
    if (resolveGenerationMode(args, username, charName, _cid) === "code") {
      const _writeRegex = /<codeMemoryWrite\s+file="([^"]+)">([\s\S]*?)<\/codeMemoryWrite>/gi;
      let _writeMatch;
      while ((_writeMatch = _writeRegex.exec(content)) !== null) {
        const [, _wFilename, _wContent] = _writeMatch;
        const _safeFilename = sanitizeFilename(_wFilename);
        if (!_safeFilename.endsWith(".md")) continue;
        try {
          const _memDir = ensureMemoryDir(username, charName);
          const _activeDir = path.join(_memDir, "code", "active");
          if (!fs.existsSync(_activeDir)) fs.mkdirSync(_activeDir, { recursive: true });
          const _wPath = path.join(_activeDir, _safeFilename);
          if (!isPathSafe(_wPath, path.resolve(_activeDir))) { // 0716 路径前缀边界修复：收口到 isPathSafe（含 path.sep 边界 + .. 检查）
            wbD(_cid, "memory", "handleReply:codeMemoryWrite:pathTraversal", false, `路径越界 ${_safeFilename}`, { file: _safeFilename });
            console.warn(`[beilu-memory] codeMemoryWrite: 路径越界 ${_safeFilename}`);
            continue;
          }
          const _parentDir = path.dirname(_wPath);
          if (!fs.existsSync(_parentDir)) fs.mkdirSync(_parentDir, { recursive: true });
          nicerWriteFileSync(_wPath, _wContent.trim());
          opLog("codeMemoryWrite", _safeFilename, { len: _wContent.length }, "ok");
          _setActiveProject(_safeFilename); // 断链根修：任务 md 写成功 = 活动任务事实点
        } catch (e) {
          wbD(_cid, "memory", "handleReply:codeMemoryWrite", false, e.message, { file: _safeFilename });
          console.error(`[beilu-memory] codeMemoryWrite 失败 ${_safeFilename}:`, e.message);
          opLog("codeMemoryWrite", _safeFilename, { error: e.message }, "fail");
        }
      }
      content = content.replace(/<codeMemoryWrite\s+file="[^"]*">[\s\S]*?<\/codeMemoryWrite>/gi, "");
    }

    // （5a2 <dataWrite> 已删，2026-07-16 凛倾拍板去重：AI 写框架/问题与 code 记忆表格 #3/#4 概念重复
    //   且无提示词教 AI 输出=死链；架构/问题知识归记忆表格单源。线路埋点不受影响——由 ideToolCall 自动写。）

    // 5b. <workMemoryWrite> — AI写入工作热层md文件
    if (resolveGenerationMode(args, username, charName, _cid) === "work") {
      const _wkWriteRegex = /<workMemoryWrite\s+file="([^"]+)">([\s\S]*?)<\/workMemoryWrite>/gi;
      let _wkWriteMatch;
      while ((_wkWriteMatch = _wkWriteRegex.exec(content)) !== null) {
        const [, _wkFilename, _wkContent] = _wkWriteMatch;
        const _safeWkFilename = sanitizeFilename(_wkFilename);
        if (!_safeWkFilename.endsWith(".md")) continue;
        try {
          const _memDir = ensureMemoryDir(username, charName);
          const _wkActiveDir = path.join(_memDir, "work", "active");
          if (!fs.existsSync(_wkActiveDir)) fs.mkdirSync(_wkActiveDir, { recursive: true });
          const _wkPath = path.join(_wkActiveDir, _safeWkFilename);
          if (!isPathSafe(_wkPath, path.resolve(_wkActiveDir))) { // 0716 路径前缀边界修复：收口到 isPathSafe（含 path.sep 边界 + .. 检查）
            wbD(_cid, "memory", "handleReply:workMemoryWrite:pathTraversal", false, `路径越界 ${_safeWkFilename}`, { file: _safeWkFilename });
            console.warn(`[beilu-memory] workMemoryWrite: 路径越界 ${_safeWkFilename}`);
            continue;
          }
          nicerWriteFileSync(_wkPath, _wkContent.trim());
          opLog("workMemoryWrite", _safeWkFilename, { len: _wkContent.length }, "ok");
          _setActiveProject(_safeWkFilename); // 断链根修：work 任务 md 同为活动任务事实点（active_project 跨模式单源）
        } catch (e) {
          wbD(_cid, "memory", "handleReply:workMemoryWrite", false, e.message, { file: _safeWkFilename });
          console.error(`[beilu-memory] workMemoryWrite 失败 ${_safeWkFilename}:`, e.message);
          opLog("workMemoryWrite", _safeWkFilename, { error: e.message }, "fail");
        }
      }
      content = content.replace(/<workMemoryWrite\s+file="[^"]*">[\s\S]*?<\/workMemoryWrite>/gi, "");
    }

    // 6. <modeSwitch> — AI 主动切换模式
    // N38 per-chatId 隔离（设计 全智能_界面设计.md :291-319「每模式独立 chatId，
    // 全程用户在 chat-chatId 继续聊天互不干扰」）：
    //   · chat→work/code = 投递语义：本线【不落盘任何模式状态】——真实执行发生在
    //     目标模式自己的 chatId（前端临时对话确认后投递，目标线由 bindChatMode 绑定），
    //     确认前后端都不得改状态（旧实现在此三层落盘 char+_global+_default，
    //     一条 AI 输出污染同 char 全部窗口=污染测试坐实的根因，勿改回）。
    //   · 其余方向（work/code→chat、code↔work）= 本对话线内转移：只写
    //     active_modes_map[_cid]，零跨窗副作用。
    const modeSwitchMatch = content.match(/<modeSwitch>(chat|code|work)<\/modeSwitch>/i);
    if (modeSwitchMatch && !_admit("modeSwitch", `→${modeSwitchMatch[1]}`)) {
      // [P0-B] 拒绝三件套已由 _admit 内 _denyOperation 记账；标签由下方 replace 照剥
    } else if (modeSwitchMatch) {
      const targetMode = modeSwitchMatch[1].toLowerCase();
      const currentMode = resolveGenerationMode(args, username, charName, _cid);
      if (targetMode !== currentMode) {
        // [P0-A 2026-08-03] 投递语义（chat|smart → work|code）已整体收口到上游提案硬门
        //   （createPendingConfirmation + 提前收尾），本段不再可达该方向——原 status:"running"
        //   的 _taskOverlay/_active_task_overlay.json 写点（确认前副作用，Fable 审查阻断2/6）随之删除。
        //   此处只剩「本对话线内真实状态转移」（work/code→chat/smart、code↔work）：写
        //   active_modes_map[_cid]，零跨窗副作用。
        const switchResult = setActiveMode(username, charName, targetMode, _cid);
        const _switchOk = !!switchResult.success;
        if (!_switchOk) {
          console.warn(`[beilu-memory] ReplyHandler modeSwitch 失败: ${switchResult.error || "未知错误"}`);
        }
        if (_switchOk) {
          opLog("modeSwitch", `${currentMode}→${targetMode}`, {}, "ok");
          reply.extension._modeSwitch = { from: currentMode, to: targetMode };

          // 从work/code切回chat/smart时，自动完成taskOverlay（旧存量 overlay 文件的收尾读点保留：
          // 提案链已不再产生该文件，此块只为消化历史残留，读不到即无操作）
          if ((targetMode === "chat" || targetMode === "smart") && (currentMode === "work" || currentMode === "code")) {
            try {
              const _backDir = getMemoryDir(username, charName);
              const _backPath = path.join(_backDir, "work", "_active_task_overlay.json");
              const _activeTask = loadJsonFileIfExists(_backPath);
              if (_activeTask?.id) {
                reply.extension._taskOverlayComplete = {
                  id: _activeTask.id,
                  result: "模式已切回聊天",
                  completedAt: new Date().toISOString(),
                };
                fs.unlinkSync(_backPath);
              }
            } catch (_e) { /* non-critical */ }
          }

          // [0716 凛倾定案] 原「AI modeSwitch 首入应用 mode_preset_bindings」块已删——
          //   「绑定」概念不存在，只有「当前正在使用的预设」（active_preset_map[cid:mode]，
          //   无记录回退全局 active_preset，目标线预设由 getPromptHandler 预设隔离解析）。
        }
      }
    }
    content = content.replace(/<modeSwitch>[\s\S]*?<\/modeSwitch>/gi, "");

    // 6b. <subModeSwitch> — AI 主动切换子模式
    // A5: 正则放宽 [\w-]+ → [^<>]+ 支持中文/空格 label；解析走 resolveSubMode 单一权威，
    //     限定当前 modeGroup（allowCrossGroup=false）——subModeSwitch 不允许跨组跳出。
    const subModeSwitchMatch = content.match(/<subModeSwitch>([^<>]+)<\/subModeSwitch>/i);
    if (subModeSwitchMatch && _admit("subModeSwitch", `→${subModeSwitchMatch[1].trim()}`)) {
      const targetSubModeRaw = subModeSwitchMatch[1].trim();
      try {
        const smUser = username;
        const smConfigPath = getYonbanConfigPath(smUser);
        const smConfig = loadJsonFileIfExists(smConfigPath, { sub_modes: [], active_sub_mode: "前置任务专家" });
        const _curModeGroup = resolveGenerationMode(args, username, charName, _cid);
        const targetSubMode = resolveSubMode(smConfig.sub_modes || [], targetSubModeRaw, _curModeGroup, false);
        if (targetSubMode) {
          // [0720 skill组域门控·凛倾「AI可以切换skill组之外的子模式」→ 0722 扩展到长期选中组] 门控=
          //   接受域集合+成员判定,域解析收口 resolveSkillGroupDomain 单源(running 组优先→用户长期选中组
          //   selected_groups[modeGroup]→无组=维持原 modeGroup 域,resolveSubMode 已限)。接受域=组文件
          //   steps[].mode 集合(零硬编码,组变域变);越域=拒绝+回执可见错误(AI 收到组内可选清单,不静默)。
          //   与 getPromptHandler 宏清单同一域源——教的与门放的一致。委派路径(allowCrossGroup=true)是
          //   delegate 语义跨组合法,不经本门。门自身读盘失败=放行(门故障不堵死切换主链)。
          const _wfDenied = (() => {
            try {
              const _dom = resolveSkillGroupDomain(username, charName, _cid, _curModeGroup);
              if (!_dom || _dom.modeIds.includes(targetSubMode.id)) return false;
              const _domLabels = _dom.modeIds
                .map((id) => (smConfig.sub_modes || []).find((m) => m.id === id)?.label || id)
                .join(" / ");
              const _domHint = _dom.source === "running"
                ? `当前 skill 组「${_dom.name}」运行中，只能切换组内子模式：${_domLabels}。需要组外子模式请先停止流程组。`
                : `当前选中的 skill 组是「${_dom.name}」，只能切换组内子模式：${_domLabels}。需要组外子模式请让用户在子模式管理面板切换 skill 组。`;
              ideClient.enqueuePendingResult({
                tool: "_sub_mode_switch_denied",
                params: { to: targetSubMode.id, workflow: _dom.name, source: _dom.source },
                result: { success: false, error: `⚠️ ${_domHint}` },
                chatid: _qcid,
                timestamp: new Date().toISOString(),
              });
              console.warn(`[beilu-memory] subModeSwitch 越域拒绝: ${targetSubMode.id} ∉ ${_dom.source === "running" ? "激活" : "选中"}组 ${_dom.filename}`);
              return true;
            } catch { return false; }
          })();
          if (!_wfDenied) {
          const targetSubModeId = targetSubMode.id;
          const _targetMg = targetSubMode.modeGroup || "code";
          const oldSubMode = resolveActiveSubModeId(smConfig, _targetMg, _cid);
          if (_checkSwitchLoop(username, charName, oldSubMode, targetSubModeId, _cid)) {
            reply.extension._stopContinue = true;
            ideClient.enqueuePendingResult({
              tool: "_switch_loop_break",
              params: { from: oldSubMode, to: targetSubModeId },
              result: { success: false, error: `⚠️ 纠错↔测试回路已超过${_SWITCH_LOOP_MAX}次切换，说明问题不是单个bug而是设计层问题。已自动停止，请重新审视整体方案。` },
              chatid: _qcid,
              timestamp: new Date().toISOString(),
            });
            console.warn(`[beilu-memory] subModeSwitch 回路保护触发，强制停止`);
          } else {
          // D3 0804 三入口收口：map 写 + activation 记录（revision/provenance 审计）+ 默认预设应用
          //   （0708 生效模型）+ 事件体构造，统一走 subModeActivation.activateSubMode（source="ai_tag"，
          //   updateYonbanConfig 单事务）。原 T4 内联 write→save + applySubModePresetDefault +
          //   buildSubModeSwitchEvent 三段=core 的第二实现，镜像清零。skill组域门/回路检测是本入口
          //   专属语义（AI 标签独有），保留 handler 层——core 只拥有「激活」本体。
          const _actRes = await activateSubModeCore({ username: smUser, charName, chatId: _cid, subModeId: targetSubModeId, source: "ai_tag" });
          if (_actRes?.success) {
          reply.extension._subModeSwitch = _actRes.event; // 事件体单源（core 内 buildSubModeSwitchEvent，chatId=map 写盘同键）
          // T046：不再下发 _subModeSwitchPreset（前端强制切预设=死绑）。_subModeSwitch 保留（驱动 tab 跟随/面板刷新）。
          // T14修复：子模式绑定model_params → 写入extension供前端同步
          if (targetSubMode.model_params) {
            reply.extension._subModeSwitchModelParams = targetSubMode.model_params;
            diag.log(`subModeSwitch: model_params → ${JSON.stringify(targetSubMode.model_params)}`);
          }
          // [0804 根因修·RC11断点7] 原此处 SetData({AIsource}) 直接改写角色全局绑定源——AI 切子模式
          //   的持久副作用会让其他窗口/角色会话跟着换源（用户点击进入同一子模式却只做 per-request，
          //   三入口不同副作用）。删除全局写：active submode 已在 core 落盘，下轮 getPromptHandler 按
          //   chatId 解析新子模式 → sub_mode_api_source extension → char-template 局部 _effSource
          //   本轮生效（per-request override 既有链，与手动生成同路）。extension 字段保留供前端感知。
          if (targetSubMode.apiSource) {
            reply.extension._subModeSwitchApiSource = targetSubMode.apiSource;
            diag.log(`subModeSwitch: 子模式带 API 覆盖 "${targetSubMode.apiSource}"（per-request 生效，不改角色全局绑定）`);
          }
          // ★ 推合成结果到pendingResults，确保自动继续（切换后新预设需要接管）
          ideClient.enqueuePendingResult({
            tool: "_sub_mode_switch",
            params: { from: oldSubMode, to: targetSubModeId },
            result: { success: true, result: `[子模式切换] ${oldSubMode} → ${targetSubModeId} (${targetSubMode.label})，新预设已激活` },
            chatid: _qcid,
            timestamp: new Date().toISOString(),
          });
          } else {
            // core fail-closed 拒绝（chat 未知/子模式不存在）：可见错误回执，零静默零半写
            ideClient.enqueuePendingResult({
              tool: "_sub_mode_switch",
              params: { from: oldSubMode, to: targetSubModeId },
              result: { success: false, error: `⚠️ 子模式激活被拒绝: ${_actRes?.error || _actRes?.code || "未知错误"}` },
              chatid: _qcid,
              timestamp: new Date().toISOString(),
            });
            console.warn(`[beilu-memory] subModeSwitch 激活拒绝: ${_actRes?.code || ""} ${_actRes?.error || ""}`);
          }
          }
          } // [0720 skill组域门] if(!_wfDenied) 闭合
        } else {
          console.warn(`[beilu-memory] subModeSwitch: 未找到子模式 "${targetSubModeRaw}"（当前组 ${_curModeGroup}，不跨组）`);
        }
      } catch (e) {
        wbD(_cid, "memory", "handleReply:subModeSwitch", false, e.message, {});
        console.warn(`[beilu-memory] subModeSwitch 失败: ${e.message}`);
      }
    }
    content = content.replace(/<subModeSwitch>[\s\S]*?<\/subModeSwitch>/gi, "");

    // 6c. <chatRename>新名字</chatRename> — AI 主动改当前对话显示名（凛倾 0709：ai也可以用指令改对话文件名字）。
    //     走 shell renameChat 单源（N39 chat_names：只改文件内记录的显示名，不改磁盘文件名；
    //     renameChat 内部 sendEventToUser chat-list-changed → 各端列表自动刷新）。
    //     动态 import shell lib = ideClient.mjs:959 chatStorage 同款先例。长度上限与 renameChat 的 100 字符截断同口径。
    const chatRenameMatch = content.match(/<chatRename>([^<>]+)<\/chatRename>/i);
    if (chatRenameMatch && _admit("chatRename", "")) {
      const _newChatName = chatRenameMatch[1].trim().substring(0, 100);
      if (_newChatName && _cid) {
        try {
          const { renameChat } = await import("../../../../../public/parts/shells/beilu-chat/src/lib/chatStorage.mjs");
          const _rnRes = await renameChat(_cid, username, _newChatName);
          if (_rnRes?.success) {
            diag.log(`chatRename: 对话 ${_cid} 显示名 → "${_newChatName}"`);
          } else {
            diag.warn(`chatRename: 改名被拒: ${_rnRes?.message || "未知原因"}`);
          }
        } catch (e) {
          wbD(_cid, "memory", "handleReply:chatRename", false, e.message, {});
          console.warn(`[beilu-memory] chatRename 失败: ${e.message}`);
        }
      } else if (!_cid) {
        console.warn(`[beilu-memory] chatRename: 无 chatid 上下文，跳过`);
      }
    }
    content = content.replace(/<chatRename>[\s\S]*?<\/chatRename>/gi, "");

    // 7. <ideToolCall> — AI 调用 IDE 工具（支持写操作审批）
    {
      const { toolCalls: _ideToolCalls, cleanContent: _afterIdeTool, rejectedContentParams: _rejectedCP = [] } = parseIdeToolCallTags(content);
      const _rawTagCount = (content.match(/<ideToolCall[\s>]/g) || []).length;
      wbT(_cid, "memory", "handleReply:ideToolCall", { parsed: _ideToolCalls.length, raw: _rawTagCount, rejectedCP: _rejectedCP.length, connected: ideClient.isConnected });
      opLog("ideToolCall", `parsed ${_ideToolCalls.length}/${_rawTagCount}`, { connected: ideClient.isConnected, raw: _rawTagCount, rejectedCP: _rejectedCP }, _ideToolCalls.length > 0 ? "ok" : "skip");
      // ★ 符号根修复：content-param 被塞进属性位 → 给「精确可操作」报错（指名参数 + 正确子标签写法），不再笼统猜差值。
      if (_rejectedCP.length > 0) {
        const _tagHint = { old_string: "<old_string>...</old_string>", new_string: "<new_string>...</new_string>", new_content: "<new_content>...</new_content>", content: "<content>...</content> 或写在 <ideToolCall ...>内容</ideToolCall> 标签体" };
        const _lines = _rejectedCP.map((p) => `  • ${p} → 改用子标签：${_tagHint[p] || `<${p}>...</${p}>`}`);
        wbD(_cid, "memory", "handleReply:ideToolCall:rejectedContentParam", false, `content-param 属性承载被硬拒: ${_rejectedCP.join(", ")}`, { params: _rejectedCP });
        diag.warn(`ideToolCall content-param 属性承载被硬拒: ${_rejectedCP.join(", ")}（这类标签含裸引号/代码会让外层解析断裂，已被拦截避免静默丢失）`);
        ideClient.enqueuePendingResult({
          tool: "_parse_error",
          params: {},
          result: { success: false, error: `⚠️ 你把代码内容写进了 ideToolCall 的属性里（${_rejectedCP.join(", ")}）。这类含代码的参数禁止放属性——值里的双引号/尖括号会让标签解析断裂、整个工具调用丢失。请改用子标签重写：\n${_lines.join("\n")}\n例：<ideToolCall tool="fuzzy_edit" path="x.js"><old_string>原文</old_string><new_string>新文</new_string></ideToolCall>` },
          chatid: _qcid,
          timestamp: new Date().toISOString(),
        });
      } else if (_rawTagCount > _ideToolCalls.length) {
        // 退化分支：差值 > 0 但探针没命中 content-param（其他格式错误，如属性名拼错/标签未闭合）
        const _failCount = _rawTagCount - _ideToolCalls.length;
        wbD(_cid, "memory", "handleReply:ideToolCall:parseLoss", false, `${_failCount}个标签格式错误被跳过(raw=${_rawTagCount}/parsed=${_ideToolCalls.length})`, { raw: _rawTagCount, parsed: _ideToolCalls.length, lost: _failCount });
        diag.warn(`ideToolCall 解析丢失: AI输出了${_rawTagCount}个标签但只解析成功${_ideToolCalls.length}个，${_failCount}个因格式错误被跳过`);
        ideClient.enqueuePendingResult({
          tool: "_parse_error",
          params: {},
          result: { success: false, error: `⚠️ 你输出了${_rawTagCount}个ideToolCall标签，但${_failCount}个解析失败被跳过。请检查标签是否正确闭合、属性名拼写、以及是否把代码内容误放进属性（应改用<old_string>/<new_string>子标签）。` },
          chatid: _qcid,
          timestamp: new Date().toISOString(),
        });
      }
      // [P0-B 2026-08-03] web_download 先行分流（websearch 域能力，与 IDE 连接/features.ide 声明无关）：
      //   独立 admission（webDownload），从工具清单摘除后再裁决 ideToolCall 本体——
      //   否则 smart/chat 等 ide:false 模式的声明门会把联网下载一并误拒。
      const _ideSignal = args?.generation_options?.signal || null; // T16 abort：取消信号传播（web_download 与 IDE 段共用）
      {
        const _wdCalls = [];
        for (let _wdI = _ideToolCalls.length - 1; _wdI >= 0; _wdI--) {
          if (_ideToolCalls[_wdI].tool === "web_download") _wdCalls.unshift(_ideToolCalls.splice(_wdI, 1)[0]);
        }
        if (_wdCalls.length > 0 && _admit("webDownload", `×${_wdCalls.length}`)) {
          for (const _tc of _wdCalls) {
            if (_ideSignal?.aborted) continue;
            try {
              const _dlUrl = (_tc.params?.url || "").toString().trim();
              const _dlMem = loadMemoryData(username, charName);
              const _dlRes = _dlUrl
                ? await executeWebDownload(_dlUrl, { filename: _tc.params?.filename }, username, _dlMem.config?.web_search || {})
                : { success: false, error: "web_download 缺少 url 参数" };
              ideClient.enqueuePendingResult({
                tool: "web_download", params: _tc.params,
                result: _dlRes.success ? { success: true, result: `[已下载] ${_dlRes.path} (${_dlRes.bytes} 字节${_dlRes.mime ? ", " + _dlRes.mime : ""})` } : { success: false, error: _dlRes.error },
                chatid: _qcid, timestamp: new Date().toISOString(),
              });
              opLog("ideToolCall", "web_download", { url: _dlUrl.substring(0, 120), ok: !!_dlRes.success }, _dlRes.success ? "ok" : "fail");
            } catch (_dlE) {
              ideClient.enqueuePendingResult({ tool: "web_download", params: _tc.params, result: { success: false, error: `下载失败: ${_dlE.message}` }, chatid: _qcid, timestamp: new Date().toISOString() });
            }
          }
        }
      }
      if (_ideToolCalls.length > 0 && !_admit("ideToolCall", `×${_ideToolCalls.length}（${_ideToolCalls.map(tc => tc.tool).join(",")}）`)) {
        // [P0-B] 拒绝三件套已由 _admit 记账（含 ModeDef features.ide 执行门——声明面=执行面，
        //   修 Fable 审查「smart.json ide:false 只影响提示词」分叉）；标签在此剥
        content = _afterIdeTool;
      } else if (_ideToolCalls.length > 0) {
        // 系统输出标记：本条 AI 回复发出了 IDE 工具调用（YonBan 命令）→ 标 _opType=ide_tool_call，
        // 让 isIdeToolCallMsg 能识别、供 token 超限时按"AI 操作"类可逆 hide（对齐工具结果的 ide_tool_result 标记）。
        if (!reply.extension) reply.extension = {};
        reply.extension._opType = "ide_tool_call";
        // B4 inline工具卡：调用侧结构化摘要进 extension（content 里的 <ideToolCall> 对 AI/用户都剥，
        // 用户侧由前端按此数组渲染"调了什么工具+对象"的内联卡=G8 对 AI 删对用户折叠）。
        reply.extension.ideToolCalls = _ideToolCalls.map((tc) => {
          const _p = tc.params || {};
          const _subject = _p.path || _p.command || _p.query || _p.pattern || "";
          const _o = { tool: tc.tool, subject: String(_subject).slice(0, 120) };
          // ★ 写工具附 diff 内容(old/new)：YonBan webview 无 `<ideToolCall>` 标签可解(本体走标签渲 diff)，
          //   故后端把 old/new 带进 ideToolCalls，让 YonBan 也能渲真红绿 diff。截断防消息膨胀(单侧≤4000)。
          //   本体 messageList 走标签、忽略这两字段，无害。
          if (IDE_WRITE_TOOLS.includes(tc.tool)) {
            const _clip = (s) => (typeof s === "string" ? (s.length > 4000 ? s.slice(0, 4000) + "\n…(truncated)" : s) : undefined);
            if (_p.old_string !== undefined || _p.new_string !== undefined) {
              _o.diffOld = _clip(_p.old_string) ?? ""; _o.diffNew = _clip(_p.new_string) ?? "";
            } else if (_p.new_content !== undefined) {
              _o.diffNew = _clip(_p.new_content) ?? "";
            } else if (_p.content !== undefined) {
              _o.diffNew = _clip(_p.content) ?? "";
            }
          }
          return _o;
        });
        // ★ 三层关联 ID（本轮所有 IDE 工具共享）：本体 opLog + YonBan ideOpLog + 前端广播 都带它，单次操作端到端可拼
        const _ideTraceId = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        opLog("ideToolCall", "details", { traceId: _ideTraceId, tools: _ideToolCalls.map(tc => ({ tool: tc.tool, params: Object.keys(tc.params || {}) })) });
        // [P0-B] web_download 分流已上提到本段头部（独立 admission），此处清单内不再含该工具
        if (ideClient.isConnected) {
          // 分离读操作和写操作
          const _readOps = _ideToolCalls.filter((_tc) => !IDE_WRITE_TOOLS.includes(_tc.tool));
          let _writeOps = _ideToolCalls.filter((_tc) => IDE_WRITE_TOOLS.includes(_tc.tool));

          // [0730] 子模式工具权限过滤：per-子模式的 allowCodeEdit/allowRunCommand/allowDelete 开关。
          //   默认不写=undefined=允许（兼容既有子模式零权限字段）。false=系统强制拒绝。
          //   被拦截的工具调用回喂 AI 错误，让 AI 知道当前身份不允许该操作。
          {
            const _smModeGroup = resolveGenerationMode(args, username, charName, _cid);
            if (_smModeGroup === "code" || _smModeGroup === "work") {
              try {
                const _smCfgPath = getYonbanConfigPath(username);
                const _smCfg = loadJsonFileIfExists(_smCfgPath, {});
                const _smActiveId = resolveActiveSubModeId(_smCfg, _smModeGroup, _cid);
                const _smActive = (_smCfg.sub_modes || []).find((m) => m.id === _smActiveId);
                if (_smActive) {
                  const _smBlocked = [];
                  if (_smActive.allowCodeEdit === false) {
                    _writeOps = _writeOps.filter((_tc) => {
                      if (FILE_EDIT_TOOLS.includes(_tc.tool)) { _smBlocked.push(_tc); return false; }
                      return true;
                    });
                  }
                  if (_smActive.allowRunCommand === false) {
                    _writeOps = _writeOps.filter((_tc) => {
                      if (_tc.tool === "run_command" || _tc.tool === "run_script") { _smBlocked.push(_tc); return false; }
                      return true;
                    });
                  }
                  if (_smActive.allowDelete === false) {
                    _writeOps = _writeOps.filter((_tc) => {
                      const _cmd = (_tc.params?.command || "").trim();
                      if (_tc.tool === "run_command" && /\b(rm|del|rmdir|remove|unlink)\b/i.test(_cmd)) { _smBlocked.push(_tc); return false; }
                      return true;
                    });
                  }
                  for (const _bl of _smBlocked) {
                    ideClient.enqueuePendingResult({
                      tool: _bl.tool, params: _bl.params,
                      result: { success: false, error: `🚫 当前子模式「${_smActive.label || _smActive.id}」不允许 ${_bl.tool} 操作。请按身份要求产出文档/清单，不要直接操作代码/脚本。` },
                      chatid: _qcid, timestamp: new Date().toISOString(),
                    });
                    opLog("ideToolCall", `submode_block:${_bl.tool}`, { subMode: _smActive.id, tool: _bl.tool }, "blocked");
                  }
                  if (_smBlocked.length > 0) {
                    wbD(_cid, "memory", "handleReply:subModePermBlock", false,
                      `子模式「${_smActive.id}」拦截 ${_smBlocked.length} 项工具(${_smBlocked.map(b => b.tool).join(",")})`,
                      { subMode: _smActive.id, blocked: _smBlocked.map(b => b.tool) });
                  }
                }
              } catch (_smErr) { console.warn("[beilu-memory] 子模式权限读取失败:", _smErr.message); }
            }
          }

          // ★ run_command 安全检查（W13 命令白名单）
          {
            // 能力授权单源 = per-user command_config.json（getCommandConfigPath，写点=setCommandConfig，
            //   UI=workPanel:534/permissionPanel 命令能力开关同链）。0714 曾短暂并入
            //   beilu-files-settings.json commandGate.capabilities 做读侧合并——同日撤销（多源合并反向回灌病），
            //   该段已废弃不再是能力存储。
            let _cmdConfigUser = {};
            try {
              const _cmdConfigPath = getCommandConfigPath(username);
              _cmdConfigUser = loadJsonFileIfExists(_cmdConfigPath) || {};
            } catch (_e) { /* no config = use defaults */ }

            // [0726 会话输出上限可调] 持久会话输出上限：用户安全设置（command_config.json
            // session_output_limit_mb，UI=permissionPanel 安全面板，缺省 10MB）。传导层注入并
            // 【覆盖】AI 自带值——这是用户安全域，禁 AI 经工具参数自抬上限；执行端再钳 1-100 兜底。
            // 注入在审批入队之前 → 指纹含此值，approveOperation 校验一致（与 session_key 注入不同层：
            // session_key 是会话路由标注在 ideClient，本值是安全域裁决随 _cmdConfigUser 同源在此）。
            {
              const _sessOutMb = Math.min(Math.max(Number(_cmdConfigUser.session_output_limit_mb) || 10, 1), 100);
              for (const _tc of _writeOps) {
                if (_tc && _tc.tool === "run_command" && _tc.params?.session === true) {
                  _tc.params = { ..._tc.params, output_limit_mb: _sessOutMb };
                }
              }
            }

            const _blockedCmds = [];
            _writeOps = _writeOps.filter((_tc) => {
              // run_script 与 run_command 同为命令执行类：run_script 合成伪命令 `${lang} <inline-code>`
              // （与 gateToolExecution:309 同口径）过同一安全闸——路径 A 的 HITL 必须在此上游完成
              // （callTool 侧 gate 3b 对 source:"ai" 短路），否则解释器授权门（node/python 默认关
              // → forced ask）对 AI 通道永不触发（20260713 确证绕过修复）。
              const _cmdText = _tc.tool === "run_command"
                ? _tc.params?.command
                : _tc.tool === "run_script"
                  ? `${(_tc.params && (_tc.params.lang || _tc.params.language)) || "script"} <inline-code>`
                  : null;
              if (!_cmdText) return true;
              const _secCheck = checkCommandSecurity(_cmdText, _cmdConfigUser);
              if (!_secCheck.allowed) {
                _blockedCmds.push(_tc);
                ideClient.enqueuePendingResult({
                  tool: _tc.tool, params: _tc.params,
                  result: { success: false, error: `🛡️ 命令被安全策略阻止: ${_secCheck.reason}` },
                  chatid: _qcid,
                  timestamp: new Date().toISOString(),
                });
                console.warn(`[beilu-memory] 命令被阻止: ${_cmdText} — ${_secCheck.reason}`);
                opLog("ideToolCall", `blocked:${_tc.tool}`, { cmd: _cmdText.substring(0, 100), reason: _secCheck.reason }, "blocked");
                return false;
              }
              if (_secCheck.needsApproval) {
                if (_secCheck.forced === false) {
                  // 0715 灰名单非强制条目（forced=false，凛倾拍板"v4不用限制,最多v3"）：先打标，
                  // 权限等级在下方才加载——加载后 <L4 升为 _forceApproval（必须升为强制，否则
                  // L2/L3 模板的 run_command allow 规则会把它静默放行，违背"L3 及以下仍要问"语义），
                  // L4 完全信任则不升 → 走普通写通道（策略档 skipApproval 免审批）。
                  _tc._graylistAsk = true;
                } else {
                  // 灰名单 forced 条目/未授权解释器/未知命令 → 系统强制档（即使 L4 也确认）
                  _tc._forceApproval = true;
                }
              }
              return true;
            });
            if (_blockedCmds.length > 0) {
            }
          }

          // 读操作 — 直接执行
          for (const _tc of _readOps) {
            if (_ideSignal?.aborted) break; // T16 abort
            try {
              await ideClient.callToolAndStore(_tc.tool, _tc.params, _qcid, _ideTraceId, _ideSignal);
              opLog("ideToolCall", `read:${_tc.tool}`, { traceId: _ideTraceId, params: _tc.params }, "ok");
            } catch (_e) {
              diag.error(`ideToolCall 读操作执行失败 ${_tc.tool}: ${_e.message}`);
              opLog("ideToolCall", `read:${_tc.tool}`, { error: _e.message, params: _tc.params }, "fail");
              // ★ 执行失败也注入错误反馈给 AI
              ideClient.enqueuePendingResult({
                tool: _tc.tool, params: _tc.params,
                result: { success: false, error: `执行失败: ${_e.message}` },
                chatid: _qcid,
                timestamp: new Date().toISOString(),
              });
            }
          }

          // ★ T1-b Gap-1：纯读未写文件的外部修改检测。写循环只在「写前」查 mtime，
          // 本轮无写的旧 read 缓存若被外部改，注入侧仍喂陈旧内容 → 这里每轮补扫一遍。
          // 排除本轮写目标（交写循环自己的 mtime 门处理，避免抢先清缓存使写循环失去 block-check）。
          try {
            // _readCache 已按 chatid 分区：只扫本对话分区（_qcid=写缓存所用键），不串别的对话的读缓存。
            const _ownReadCache = ideClient._readCache?.get(_qcid);
            if (_ownReadCache && _ownReadCache.size > 0) {
              const _writeTargetSet = new Set(_writeOps.map((_w) => _w.params?.path).filter(Boolean));
              const _stalePaths = [];
              for (const [_rp, _ci] of _ownReadCache.entries()) {
                if (!_rp || _writeTargetSet.has(_rp) || _ci?.mtime == null) continue;
                const _rpAbs = ideClient.resolvePathForFs(_rp, _qcid); // 多开：按本会话所绑窗口的根解析
                let _isStale = false;
                try {
                  const _curMtime = fs.statSync(_rpAbs).mtimeMs;
                  if (_curMtime !== _ci.mtime) {
                    _isStale = true;
                  } else if (ideClient.hasExternalChange?.(_rp, _cid) && _ci.hash) {
                    try {
                      const _curHash = crypto.createHash("md5").update(await fs.promises.readFile(_rpAbs, "utf-8")).digest("hex");
                      if (_curHash !== _ci.hash) _isStale = true;
                    } catch { /* 读不出 → 不武断判定 */ }
                  }
                } catch { /* 文件已删/无权限 → 此处不处理 */ }
                if (_isStale) _stalePaths.push(_rp);
              }
              if (_stalePaths.length > 0) {
                let _hiddenOkPR = false;
                try {
                  const _chatOpsPathPR = path.join(__pluginDir, "..", "..", "shells", "beilu-chat", "src", "lib", "chatOps.mjs");
                  const _chatOpsPR = await import(pathToFileURL(_chatOpsPathPR).href);
                  const _totalLenPR = _cid ? await _chatOpsPR.GetChatLogLength(_cid) : 0;
                  const _chatLogPR = _totalLenPR > 0 ? await _chatOpsPR.GetChatLog(_cid, 0, _totalLenPR) : null;
                  if (_chatLogPR && Array.isArray(_chatLogPR)) {
                    const _hideIdxPR = [];
                    for (let i = 0; i < _chatLogPR.length; i++) {
                      const e = _chatLogPR[i];
                      if (isIdeToolResultMsg(e) && e.content && _stalePaths.some((p) => e.content.includes(p))) {
                        _hideIdxPR.push(i);
                      }
                    }
                    if (_hideIdxPR.length > 0) {
                      // T3 id锚定：按稳定 entry.id 传递，hideMessages reload后按id重定位下标，防TOCTOU漂移
                      const _idsPR = _hideIdxPR.map((i) => _chatLogPR[i]?.id);
                      await _chatOpsPR.hideMessages(_cid, _hideIdxPR, true, { ...(_idsPR.every(Boolean) ? { ids: _idsPR } : {}), meta: { by: "auto", reason: "pure_read_external_change" } });
                      diag.log(`纯读外部修改: 隐藏(可逆)${_hideIdxPR.length}条旧读取 ${_stalePaths.map(p => path.basename(p)).join(", ")}`);
                    }
                    _hiddenOkPR = true;
                  }
                } catch (_prErr) {
                  diag.warn(`纯读外部修改隐藏失败,降级写marks: ${_prErr.message}`);
                }
                if (!_hiddenOkPR) {
                  try {
                    const _cleanPathPR = path.join(ensureMemoryDir(username, charName), "hot", "_context_clean_marks.json");
                    let _marksPR = loadJsonFileIfExists(_cleanPathPR);
                    if (!Array.isArray(_marksPR)) _marksPR = [];
                    for (const _p of _stalePaths) {
                      _marksPR.push({ command: `read_file:${_p}`, source: "pure_read_external_change", timestamp: new Date().toISOString() });
                    }
                    saveJsonFile(_cleanPathPR, _marksPR);
                  } catch (_cleanErrPR) {
                    diag.warn(`纯读外部修改标记写入失败: ${_cleanErrPR.message}`);
                  }
                }
                for (const _sp of _stalePaths) {
                  ideClient.removeFromReadCache(_sp, _cid);
                  ideClient.clearExternalChange?.(_sp, _cid);
                  ideClient.enqueuePendingResult({
                    tool: "_file_modified_warning", params: { path: _sp },
                    result: { success: false, error: `⚠️ ${path.basename(_sp)} 在你上次读取后被外部修改。上下文中的旧内容已自动隐藏（可恢复）。请重新 read_file 获取最新内容再操作。` },
                    chatid: _qcid,
                    timestamp: new Date().toISOString(),
                  });
                }
              }
            }
          } catch (_scanErr) {
            diag.warn(`纯读外部修改扫描失败: ${_scanErr.message}`);
          }

          // 写操作 — 检查是否需要确认（含灰名单强制确认）
          // ★ W66修复：读取用户权限等级，Level 4（完全信任）跳过审批
          let _userPermLevel = 0;
          try {
            const _plPath = path.join(__projectRoot, "data", "users", username, "permission_level.json");
            const _plData = loadJsonFileIfExists(_plPath, { level: 0 });
            _userPermLevel = _plData.level || 0;
          } catch { /* default 0 */ }
          // ★ 0715 灰名单非强制条目（_graylistAsk）分档落地：<L4 升为系统强制档（信任档/allow 规则均不可跳），
          //   L4 保持普通写（下方策略档 skipApproval 免审批）。放在 _hasForceApproval 计算前，保证下游读到升档后状态。
          if (_userPermLevel < 4) {
            for (const _tc of _writeOps) { if (_tc && _tc._graylistAsk) _tc._forceApproval = true; }
          }
          const _hasForceApproval = _writeOps.some((_tc) => _tc._forceApproval);
          // ★ T2 S1：Level 4「完全信任」只能跳过普通写(要问档)；危险/灰名单(系统强制档)仍走门——删库无拦截是真风险。
          // Level 5「全部放行」跳过所有审批包括系统强制档（用户选择时已确认风险）。
          const _skipApproval = _userPermLevel >= 4;
          const _skipAllApproval = _userPermLevel >= 5;
          // ★ Phase 2 模块4：沙盒配置读取（提前到审批判断前，两个分支共用）
          let _sandboxBackup = false;
          try {
            const _ybCfgPath = getYonbanConfigPath(username);
            const _ybCfg = loadJsonFileIfExists(_ybCfgPath, {});
            const _curSubId = resolveActiveSubModeId(_ybCfg, resolveGenerationMode(args, username, charName, _cid), _cid);
            const _curSubCfg = (_ybCfg.sub_modes || []).find(m => m.id === _curSubId);
            _sandboxBackup = _curSubCfg?.sandboxBackup || false;
          } catch { /* default false */ }
          // ★ B3 规则集引擎（F6 升级为三态 allow/ask/deny）：加载 per-user 规则，对每条写 op 裁决。
          //   - deny：不放行，不入队、不执行——按 reject 路径回结果给 AI（系统强制确认/区外/高敏档在引擎层永不被覆盖）。
          //   - allow：自动放行（沿用 F6 _skipRuleOps 路径，不入队、不阻塞，落执行循环）。
          //   - ask（含敏感默认 .env/删除、无命中默认）：保留进下方审批门 _writeOps。
          //   规则只豁免「要问档」普通写；系统强制档（危险/区外）在 evaluateRuleAction 内部已挡为 ask，永不被豁免。
          let _skipRuleOps = [];
          if (_writeOps.length > 0) {
            try {
              const _arPath = path.join(__projectRoot, "data", "users", username, "ide_approval_rules.json");
              const _arData = loadJsonFileIfExists(_arPath, { rules: [] });
              const _rules = Array.isArray(_arData?.rules) ? _arData.rules : [];
              // ★ FT2：区外访问开关（KILO 式权限）。默认 true=完全访问工作区外；用户面板关闭=区外回 ask(非 forced)。
              //   缺省/缺字段 → true（向后兼容旧规则文件 = 区外开放，符合凛倾"默认开放"拍板）。
              const _allowOutside = _arData?.allowOutsideWorkspace !== false;
              // deny + 敏感默认删除/.env 即使无用户规则也要裁决 → 始终遍历（不再以 _rules.length 为前提）。
              const _kept = [];
              const _denyOps = [];
              for (const _tc of _writeOps) {
                const _dec = evaluateRuleDecision(_tc, _rules, ideClient.workspaceRootFor(_qcid), { allowOutsideWorkspace: _allowOutside }); // {action, forced}（多开：区内外按本会话所绑窗口的根判）
                if (_dec.action === "deny") _denyOps.push(_tc);
                else if (_dec.action === "allow") _skipRuleOps.push(_tc);
                else {
                  // 必问 ask（显式规则/敏感默认/不可解析）打 _askForced：gate 按系统强制档处理，Level4 信任也不许静默跳
                  if (_dec.forced) _tc._askForced = true;
                  _kept.push(_tc);
                }
              }
              if (_denyOps.length > 0) {
                console.warn(`[beilu-memory] ★B3 规则 deny 拒绝 ${_denyOps.length} 项写操作（不入队、回结果给 AI）`);
                for (const _dOp of _denyOps) {
                  opLog("ideToolCall", `deny:${_dOp.tool}`, { params: _dOp.params }, "blocked");
                  ideClient.enqueuePendingResult({
                    tool: _dOp.tool, params: _dOp.params,
                    result: { success: false, error: `🚫 操作被权限规则拒绝（deny）：${_dOp.tool}${_dOp.params?.path ? " " + _dOp.params.path : ""}。该路径/工具在你的权限规则集中被设为禁止，无法执行。如需放行请在权限面板调整规则。` },
                    chatid: _qcid,
                    timestamp: new Date().toISOString(),
                  });
                }
              }
              if (_denyOps.length > 0 || _skipRuleOps.length > 0) {
                if (_skipRuleOps.length > 0) console.log(`[beilu-memory] ★B3 规则 allow 放行 ${_skipRuleOps.length} 项写操作（命中规则）`);
                _writeOps = _kept;
              }
            } catch (_arE) { diag.warn(`审批规则裁决失败: ${_arE.message}`); }
          }
          if (_writeOps.length > 0 || _skipRuleOps.length > 0) {
            // ★ T2 S1 系统门：高敏档(_forceApproval/_askForced)信任不可跳过；要问档(requireWriteApproval/sandboxBackup)信任可跳。
            // 0714 根因修（审批粒度批→逐op）：原把整批 _writeOps 交 gate 批判定——一个 forced op（灰名单命令/
            //   解释器/必问规则）会把本可 L4 放行的普通写整批拖进审批队列（forced 传染，10:26 事故实证）。
            //   现按 op 分档：forced 档恒入队（信任不可跳，系统强制语义不变）；普通档交 gate 按策略档判定（L4 可跳）。
            //   evaluateWriteApprovalGate 纯函数不动，只是喂它普通档子集（其 hasForceApproval 对该子集恒 false）。
            const _forcedOps = _writeOps.filter((_tc) => _tc && (_tc._forceApproval || _tc._askForced));
            const _normalOps = _writeOps.filter((_tc) => !(_tc && (_tc._forceApproval || _tc._askForced)));
            const _gate = _normalOps.length > 0
              ? evaluateWriteApprovalGate({
                  writeOps: _normalOps,
                  // SEC 破口C：按【本回合用户】(reply 属主)取写审批开关，防读到他人的全局值
                  requireWriteApproval: ideClient.getRequireWriteApproval(username),
                  sandboxBackup: _sandboxBackup,
                  skipApproval: _skipApproval,
                  workspaceRoot: ideClient.workspaceRootFor(_qcid), // 多开：审批门区内外轴按本会话所绑窗口的根
                })
              : { needApproval: false, systemForced: false, hasForceApproval: false, outsideWorkspace: false, policyApproval: false };
            if (_forcedOps.length > 0 && _skipApproval && !_skipAllApproval) {
              console.warn(`[beilu-memory] ★T2 S1 系统门：${_forcedOps.length} 项危险/必问操作即使完全信任(Level4)仍入审批（本批其余普通写不再被拖累）`);
            }
            if (_skipAllApproval && (_forcedOps.length > 0 || _normalOps.length > 0)) {
              console.log(`[beilu-memory] ★L5 全部放行：${_forcedOps.length + _normalOps.length} 项操作（含 ${_forcedOps.length} 项强制档）跳过审批直接执行`);
            }
            // L5：全部直接执行，无审批；L4：forced 入队 + 普通免审批；L0-3：按策略档判
            const _queueOps = _skipAllApproval ? [] : (_gate.needApproval ? [..._forcedOps, ..._normalOps] : _forcedOps);
            const _execPolicyOps = _skipAllApproval ? [..._forcedOps, ..._normalOps] : (_gate.needApproval ? [] : _normalOps);
            if (_queueOps.length > 0) {
              // ★ 需要审批：加入待审批队列，不立即执行
              let _cpId = null;
              let _approvalGenerationId = "";
              try {
                const { chatId: _ideChatId, messageIndex: _ideMsgIndex, messageId: _ideMsgId } = await _getReplyCoordinates();
                _approvalGenerationId = _ideMsgId || _ideTraceId;
                // deferred=true：审批检查点不抢占全局 _activeId、不被后续轮 start auto-commit；
                // 批准写操作时靠 approveOperation 注入的 _checkpointId 钉住快照目标（见 ideClient.approveOperation）
                const _cpResult = await ideClient.startCheckpoint(_ideChatId, _ideMsgIndex, true, _ideMsgId);
                _cpId = _cpResult.id;
              } catch (_cpE) {
                console.warn("[beilu-memory] 审批检查点启动失败:", _cpE.message);
              }
              if (!_approvalGenerationId) _approvalGenerationId = _ideTraceId;
              for (const _tc of _queueOps) {
                // 每项只生成一次 operationId；submit 内部不重试。若主端 timeout/拒绝，保留同 ID
                // 进入显式错误协议，禁止换 ID 盲发形成重复审批。
                const _approvalOperationId = typeof _tc._approvalOperationId === "string" && _tc._approvalOperationId
                  ? _tc._approvalOperationId
                  : (crypto.randomUUID?.() || crypto.randomBytes(16).toString("hex"));
                _tc._approvalOperationId = _approvalOperationId;
                try {
                  const _approvalAck = await ideClient.submitPendingApproval(_tc, _cpId, _qcid, {
                    operationId: _approvalOperationId,
                    username,
                    generationId: _approvalGenerationId,
                  });
                  opLog("ideToolCall", `approval:${_tc.tool}`, {
                    params: _tc.params,
                    approvalId: _approvalAck.approvalId,
                    operationId: _approvalAck.operationId,
                  }, "ok");
                  ideClient.enqueuePendingResult({
                    tool: _tc.tool, params: _tc.params,
                    result: {
                      success: false,
                      pending: true,
                      approvalId: _approvalAck.approvalId,
                      operationId: _approvalAck.operationId,
                      error: `⏳ ${_tc.tool} 已提交审批队列，等待用户确认后执行。请勿重复提交此操作。`,
                    },
                    chatid: _qcid,
                    timestamp: new Date().toISOString(),
                  });
                } catch (_approvalError) {
                  const _approvalIndeterminate = _approvalError?.indeterminate === true;
                  opLog("ideToolCall", `approval:${_tc.tool}`, {
                    params: _tc.params,
                    operationId: _approvalOperationId,
                    code: _approvalError?.code || "E_APPROVAL_SUBMISSION_FAILED",
                    indeterminate: _approvalIndeterminate,
                  }, "fail");
                  ideClient.enqueuePendingResult({
                    tool: _tc.tool,
                    params: _tc.params,
                    result: {
                      success: false,
                      pending: false,
                      operationId: _approvalOperationId,
                      errorCode: _approvalError?.code || "E_APPROVAL_SUBMISSION_FAILED",
                      indeterminate: _approvalIndeterminate,
                      error: _approvalError?.message || String(_approvalError),
                    },
                    chatid: _qcid,
                    timestamp: new Date().toISOString(),
                  });
                }
              }
              // ★ W66 审批入队广播已收口进主进程 ideClient 队列写口（队列 owner 读权威队列出角标数；
              //   worker 必须 await 桥 ack，禁止把非权威 isolate 本地状态当作已提交）。
            }
            // 立即执行集：F6 规则放行(_skipRuleOps) + 策略档免审批普通写(_execPolicyOps)——统一走下方执行路径
            //   （沙盒/checkpoint/route 一致；原 F6 在审批分支里裸 callToolAndStore 缺沙盒备份，随本次分流一并归一）。
            _writeOps = [..._skipRuleOps, ..._execPolicyOps];
              _skipRuleOps = [];
              if (_writeOps.length > 0) {
                let _cpId = null;
                let _ideChatId = "";
                try {
                  const _replyCoords = await _getReplyCoordinates();
                  _ideChatId = _replyCoords.chatId;
                  const _cpResult = await ideClient.startCheckpoint(_ideChatId, _replyCoords.messageIndex, false, _replyCoords.messageId);
                  _cpId = _cpResult.id;
                } catch (_cpE) {
                  console.warn("[beilu-memory] 文件检查点启动失败:", _cpE.message);
                }
              // ★ Phase 2 模块4：简易沙盒 — 物理备份（写操作执行前，_sandboxBackup 在审批判断前的外层提前定义，grep `let _sandboxBackup = false`）
              if (_sandboxBackup) {
                for (const _tc of _writeOps) {
                  if (_tc.params?.path && _tc.tool !== "run_command") {
                    try {
                      const _tgtAbs = ideClient.resolvePathForFs(_tc.params.path, _qcid); // 多开：按本会话所绑窗口的根解析
                      if (fs.existsSync(_tgtAbs)) {
                        const _bakPath = _tgtAbs + ".bak_" + Date.now();
                        fs.copyFileSync(_tgtAbs, _bakPath);
                        _tc._backupPath = _bakPath;
                        _tc._resolvedPath = _tgtAbs;
                      } else {
                        // sandbox 已开但解析后路径不存在 → 备份被跳过。落日志，否则"开了备份却没备份"无从排查
                        diag.warn(`sandbox backup 跳过(文件不存在): ${_tc.params.path} → ${_tgtAbs}（workspaceRoot=${ideClient.workspaceRootFor(_qcid) || "空"}）`);
                      }
                    } catch (_bakE) {
                      console.warn(`[beilu-memory] sandbox backup failed: ${_bakE.message}`);
                    }
                  }
                }
              }

              const _autoCleanPaths = [];
              // data 系统 v2：解析当前活动任务（active_project）。有任务才记 route；文件编辑工具才记。
              let _routeTask = "";
              try {
                const _ccPath = getCodeConfigPath(username, charName); // T7 尾段收口：权威路径单点（ensureMemoryDir 副作用点在主链上游已保证）
                const _cc = loadJsonFileIfExists(_ccPath, {});
                _routeTask = (_cc && _cc.active_project) || "";
              } catch { /* 无活动任务 = 跳过 route 埋点 */ }
              const _DS_EDIT_TOOLS = [...FILE_EDIT_TOOLS]; // canonical（ideClient.mjs 单一定义），展开为数组供 .includes 使用
              for (const _tc of _writeOps) {
                if (_ideSignal?.aborted) break; // T16 abort
                const _targetPath = _tc.params?.path;
                // ★ 文件外部修改检测：写操作前检查mtime
                if (_targetPath && _tc.tool !== "run_command") {
                  const _cached = ideClient._readCache.get(_qcid)?.get(_targetPath);
                  if (_cached?.mtime) {
                    try {
                      const _curMtime = fs.statSync(ideClient.resolvePathForFs(_targetPath, _qcid)).mtimeMs; // 多开：按本会话所绑窗口的根解析（同 :1983 口径，漏网补齐 0726）
                      if (_curMtime !== _cached.mtime) {
                        diag.warn(`文件外部修改检测: ${path.basename(_targetPath)} mtime变化 (${_cached.mtime} → ${_curMtime})`);
                        ideClient.enqueuePendingResult({
                          tool: "_file_modified_warning", params: { path: _targetPath },
                          result: { success: false, error: `⚠️ ${path.basename(_targetPath)} 在你上次读取后被外部修改。上下文中的旧内容已自动隐藏（可恢复）。请重新 read_file 获取最新内容再操作。` },
                          chatid: _qcid,
                          timestamp: new Date().toISOString(),
                        });
                        _autoCleanPaths.push(_targetPath);
                        ideClient.removeFromReadCache(_targetPath, _qcid);
                        // 写被跳过 → 清理已创建的沙盒备份，防孤儿泄漏
                        if (_tc._backupPath) {
                          try { fs.unlinkSync(_tc._backupPath); } catch { /* ignore */ }
                          _tc._backupPath = null;
                          _tc._resolvedPath = null;
                        }
                        continue;
                      }
                    } catch { /* 文件不存在等，继续执行 */ }
                  }
                }
                try {
                  await ideClient.callToolAndStore(_tc.tool, _tc.params, _qcid, _ideTraceId, _ideSignal);
                  // ★ 写成功后：旧read结果已过时，标记自动清理
                  if (_targetPath && _tc.tool !== "run_command") {
                    _autoCleanPaths.push(_targetPath);
                    try {
                      const _newMtime = fs.statSync(ideClient.resolvePathForFs(_targetPath, _qcid)).mtimeMs; // 多开：按本会话所绑窗口的根解析（同 :1983 口径，漏网补齐 0726）
                      const _existing = ideClient._readCache.get(_qcid)?.get(_targetPath);
                      if (_existing) _existing.mtime = _newMtime;
                    } catch { /* ignore */ }
                  }
                  // ★ 沙盒备份消费：写成功 → checkpoint 已覆盖回滚，删除 .bak 防孤儿泄漏
                  if (_tc._backupPath) {
                    try { fs.unlinkSync(_tc._backupPath); } catch { /* 已不存在则忽略 */ }
                    _tc._backupPath = null;
                    _tc._resolvedPath = null;
                  }
                  // data 系统 v2：route 埋点（写成功）+ 同处反复修改检测
                  if (_routeTask && _DS_EDIT_TOOLS.includes(_tc.tool)) {
                    try {
                      const _tgt = _dsEditTargetOf(_tc.tool, _tc.params);
                      const _lbl = _dsTargetLabel(_tgt);
                      // 先检测（detectRepeatedEdit 的 repeat 已含本次），再 append，避免重复计数。
                      const _rep = _dsDetectRepeatedEdit(username, charName, _routeTask, _tgt, null);
                      _dsAppendRouteEvent(username, charName, _routeTask, { action: "edit", target: _lbl, node: _tc.tool, errorAfter: null });
                      if (_rep.triggered) _dsUpsertRepeatWarning(username, charName, _routeTask, _lbl, _rep.repeat, _rep.persistentError);
                    } catch (_rtE) { diag.warn(`route 埋点失败(成功路径): ${_rtE.message}`); }
                  }
                } catch (_e) {
                  diag.error(`ideToolCall 执行失败 ${_tc.tool}: ${_e.message}`);
                  opLog("ideToolCall", `write:${_tc.tool}`, { error: _e.message, params: _tc.params }, "fail");
                  // ★ 沙盒备份消费：写失败 → 从 .bak 物理还原，再删除备份
                  if (_tc._backupPath) {
                    try {
                      const _restoreTo = _tc._resolvedPath || ideClient.resolvePathForFs(_tc.params.path, _qcid); // 多开：回退分支同口径带 _qcid（_resolvedPath 与 _backupPath 恒成对赋值，此回退实际难达但口径必须一致）
                      fs.copyFileSync(_tc._backupPath, _restoreTo);
                      diag.warn(`sandbox 写失败已从备份还原: ${path.basename(_restoreTo)}`);
                    } catch (_restoreErr) {
                      diag.error(`sandbox 备份还原失败: ${_restoreErr.message}`);
                    }
                    try { fs.unlinkSync(_tc._backupPath); } catch { /* ignore */ }
                    _tc._backupPath = null;
                    _tc._resolvedPath = null;
                  }
                  // data 系统 v2：route 埋点（写失败，记 errorAfter 供持续错误检测）
                  if (_routeTask && _DS_EDIT_TOOLS.includes(_tc.tool)) {
                    try {
                      const _tgt = _dsEditTargetOf(_tc.tool, _tc.params);
                      const _lbl = _dsTargetLabel(_tgt);
                      const _rep = _dsDetectRepeatedEdit(username, charName, _routeTask, _tgt, _e.message);
                      _dsAppendRouteEvent(username, charName, _routeTask, { action: "edit", target: _lbl, node: _tc.tool, errorAfter: _e.message });
                      if (_rep.triggered) _dsUpsertRepeatWarning(username, charName, _routeTask, _lbl, _rep.repeat, _rep.persistentError);
                    } catch (_rtE) { diag.warn(`route 埋点失败(失败路径): ${_rtE.message}`); }
                  }
                  ideClient.enqueuePendingResult({
                    tool: _tc.tool, params: _tc.params,
                    result: { success: false, error: `执行失败: ${_e.message}` },
                    chatid: _qcid,
                    timestamp: new Date().toISOString(),
                  });
                }
              }
              // data 系统 v2：把未消的"同处反复修改"警告回流为工具 hint。
              // warning 落 beilu 侧 {task}.state.json，YonBan 跨进程读不到 → 必须在此 beilu 侧注入。
              // getActiveWarnings 是框架设计的回流读取口（acked 生命周期：次数刷新→重新提醒，用户手动消警才停）。
              // 仅 IDE 已连接时注入：未连接时本就不该续改，且避免该 advisory 让 P0-8 熔断的 _allDisconnected 误判为 false。
              if (_routeTask && ideClient.isConnected) {
                try {
                  const _activeWarns = _dsGetActiveWarnings(username, charName, _routeTask);
                  if (_activeWarns && _activeWarns.length > 0) {
                    const _wLines = _activeWarns.map((w) =>
                      `· ${w.position} 已被反复修改 ${w.count} 次${w.persistentError ? "（且每次都报错，疑似方向错误）" : ""}`
                    );
                    ideClient.enqueuePendingResult({
                      tool: "_repeat_edit_warning",
                      params: {},
                      result: { warning: `检测到同处反复修改，请停下来重新核对思路、追根因，而非继续盲改：\n${_wLines.join("\n")}` },
                      chatid: _qcid,
                      timestamp: new Date().toISOString(),
                    });
                  }
                } catch (_wE) { diag.warn(`反复修改警告回流失败: ${_wE.message}`); }
              }
              // ★ 旧 read 结果已过时 → 走 hideMessages 可逆隐藏（对齐 <contextClean> read_file 路径），
              // 内容留盘可恢复、仅注入侧不送 AI；不再做不可逆的内容覆盖。
              // chatOps 不可达时降级写 _context_clean_marks.json，由 getPromptHandler 回退消费。
              if (_autoCleanPaths.length > 0) {
                const _uniqPaths = [...new Set(_autoCleanPaths)];
                let _hiddenOk = false;
                try {
                  const _chatOpsPathAC = path.join(__pluginDir, "..", "..", "shells", "beilu-chat", "src", "lib", "chatOps.mjs");
                  const _chatOpsAC = await import(pathToFileURL(_chatOpsPathAC).href);
                  const _totalLenAC = _cid ? await _chatOpsAC.GetChatLogLength(_cid) : 0;
                  const _chatLogAC = _totalLenAC > 0 ? await _chatOpsAC.GetChatLog(_cid, 0, _totalLenAC) : null;
                  if (_chatLogAC && Array.isArray(_chatLogAC)) {
                    const _hideIdxAC = [];
                    for (let i = 0; i < _chatLogAC.length; i++) {
                      const e = _chatLogAC[i];
                      if (isIdeToolResultMsg(e) && e.content && _uniqPaths.some((p) => e.content.includes(p))) {
                        _hideIdxAC.push(i);
                      }
                    }
                    if (_hideIdxAC.length > 0) {
                      // T3 id锚定：按稳定 entry.id 传递，hideMessages reload后按id重定位下标，防TOCTOU漂移
                      const _idsAC = _hideIdxAC.map((i) => _chatLogAC[i]?.id);
                      await _chatOpsAC.hideMessages(_cid, _hideIdxAC, true, { ...(_idsAC.every(Boolean) ? { ids: _idsAC } : {}), meta: { by: "auto", reason: "auto_write_cleanup" } });
                      diag.log(`自动写清理: 隐藏(可逆)${_hideIdxAC.length}条旧读取 ${_uniqPaths.map(p => path.basename(p)).join(", ")}`);
                    }
                    _hiddenOk = true;
                  }
                } catch (_hideErr) {
                  diag.warn(`自动写清理隐藏失败,降级写marks: ${_hideErr.message}`);
                }
                if (!_hiddenOk) {
                  try {
                    const _cleanDir = ensureMemoryDir(username, charName);
                    const _cleanPath = path.join(_cleanDir, "hot", "_context_clean_marks.json");
                    let _marks = loadJsonFileIfExists(_cleanPath);
                    if (!Array.isArray(_marks)) _marks = [];
                    for (const _p of _uniqPaths) {
                      _marks.push({ command: `read_file:${_p}`, source: "auto_write_cleanup", timestamp: new Date().toISOString() });
                    }
                    saveJsonFile(_cleanPath, _marks);
                    diag.log(`自动清理旧读取(marks兜底): ${_uniqPaths.map(p => path.basename(p)).join(", ")}`);
                  } catch (_cleanErr) {
                    diag.warn(`自动清理标记写入失败: ${_cleanErr.message}`);
                  }
                }
                }
                if (_cpId) {
                  try {
                    await ideClient.commitCheckpoint(_cpId, _ideChatId);
                  } catch (_cpE) {
                  console.warn("[beilu-memory] 文件检查点提交失败:", _cpE.message);
                }
              }
            }
          } else if (_readOps.length > 0) {
          }
        } else {
          // ★ 关键修复：IDE 未连接时，把错误反馈注入到 pendingResults
          // 这样 AI 下一轮会看到"未连接"的错误，而不是静默丢弃
          console.warn(`[beilu-memory] ReplyHandler: AI 请求 IDE 工具调用但 YonBan 未连接`);
          opLog("ideToolCall", "ide-disconnected", { tools: _ideToolCalls.map(tc => tc.tool) }, "fail");
          for (const _tc of _ideToolCalls) {
            ideClient.enqueuePendingResult({
              tool: _tc.tool,
              params: _tc.params,
              result: { success: false, error: "IDE 未连接 — YonBan 插件未启动或 WebSocket 未建立。请让用户检查 IDE 连接状态。" },
              chatid: _qcid,
              ownerUsername: username,
              timestamp: new Date().toISOString(),
            });
          }
        }
        content = _afterIdeTool;

        // W65: 工具执行完毕后通过WS广播通知前端（替代轮询等待）
        const _chatPendingResults = ideClient.getPendingResults({
          ownerUsername: username,
          chatid: _qcid || undefined,
        });
        if (_chatPendingResults.length > 0) {
          const _isReadOnly = !_ideToolCalls.some(_tc => IDE_WRITE_TOOLS.includes(_tc.tool));
          // ★ P2-5: 收集失败的工具信息
          const _failedTools = _chatPendingResults
            .filter(r => r.result && r.result.success === false)
            .map(r => ({ tool: r.tool, error: (r.result.error || "").substring(0, 100) }));
          try {
            // [0716 T3对接首批] 改经 bus:broadcast.emit 出口；原 _bcChatOps(chatOps.mjs) import 零消费=死代码，纯删。
            const _bcChatId = args?.chatid || (args?.chat_name ? args.chat_name.replace("common_chat_", "") : "");
            if (_bcChatId) {
              await dispatch({ target: "bus:broadcast", verb: "emit", source: "yonban", payload: { chatid: _bcChatId, event: {
                type: "tool_results_ready",
                payload: {
                  count: _chatPendingResults.length,
                  source: "ideToolCall",
                  traceId: _ideTraceId,
                  readOnly: _isReadOnly,
                  stopContinue: !!_preExtracted.stopContinue,
                  failedTools: _failedTools.length > 0 ? _failedTools : undefined,
                },
              } } });
            }
          } catch (_bcErr) { /* 广播失败不影响主流程 */ }
        }
      }
    }

    // 7.5 <question> — AI 通过 IDE 弹窗向用户提问（YonBan InputBox 往返）
    //   传导链：AI 输出 <question>文本</question> → 本节解析剥标签 → ideClient.askQuestion 发 WS question
    //   → YonBan IdeWsServer 弹 VSCode InputBox（IdeWsServer.ts case "question"）→ question_answer 回传
    //   → 结果走 enqueuePendingResult 复用 pendingResults 既有管道（consumePendingResults →
    //   formatToolResultsForInjection 注入下轮 AI 对话），不另造传导管道。
    //   fire-and-forget：用户最长 60s 才答/超时，不阻塞回复处理链；迟到的回答在下轮生成时注入。
    //   结果用 string 形态（格式化器 typeof string 直通分支），对象形态会被字段白名单丢弃 AI 看不到。
    if (content.includes("<question>")) {
      const { questions: _ideQuestions, cleanContent: _afterQuestion } = parseQuestionTags(content);
      if (_ideQuestions.length > 0 && !_admit("question", `×${_ideQuestions.length}`)) {
        // [P0-B] 拒绝三件套已由 _admit 记账（含 features.ide 执行门 + Bot 宿主能力门），标签照剥
      } else if (_ideQuestions.length > 0 && !readFilesPermission(username, "questions", true)) {
        // 权限门：workPanel「向用户提问」开关（beilu-files permissions.questions，默认 true）。
        // 该键此前是双域死键（file_op 无 type / B3 桥无映射），本通道即其消费方——键与通道闭环。
        // 关闭时不弹窗、可见诊断回注（渠道拒绝=可见诊断面，不静默吞）。
        opLog("question", "permission_off", { count: _ideQuestions.length }, "blocked");
        wbD(_cid, "memory", "handleReply:question:permissionOff", false, "questions 权限关闭，拒绝弹窗提问", { count: _ideQuestions.length });
        ideClient.enqueuePendingResult({
          tool: "_question",
          params: {},
          result: { success: false, error: `提问功能已被用户关闭（权限面板「向用户提问」开关），共 ${_ideQuestions.length} 个问题未发出。请按默认方案继续并在回复中向用户说明。` },
          chatid: _qcid,
          timestamp: new Date().toISOString(),
        });
      } else if (_ideQuestions.length > 0) {
        wbT(_cid, "memory", "handleReply:question", { count: _ideQuestions.length, connected: ideClient.isConnected });
        opLog("question", `parsed ${_ideQuestions.length}`, { connected: ideClient.isConnected }, "ok");
        // 串行链（整链 fire-and-forget，不阻塞回复处理）：多个 <question> 逐个弹、上一个答完/超时
        // 才弹下一个。并发发送会同时开多个 VSCode InputBox——quick-input 是单栈，后弹顶掉前弹，
        // 前面的问题全部以"用户取消"收场。askQuestion 内部处理未连接/超时/发送失败（均 resolve 不 reject）。
        void _ideQuestions.reduce(
          (_chain, _q) => _chain.then(() =>
            ideClient.askQuestion(_q, undefined, _qcid).then((_ans) => { // 多开：提问弹到本会话所绑窗口
              ideClient.enqueuePendingResult({
                tool: "_question",
                params: { question: _q },
                result: _ans.answered
                  ? { success: true, result: `[用户通过 IDE 弹窗回答]\n问题: ${_q}\n回答: ${_ans.answer}` }
                  : { success: false, error: `提问未获回答: ${_ans.error || "未知原因"}（问题: ${_q.slice(0, 80)}）` },
                chatid: _qcid,
                timestamp: new Date().toISOString(),
              });
            })
          ),
          Promise.resolve(),
        );
      }
      content = _afterQuestion;
    }

    // scheduleTask 标签解析（AI创建定时任务）
    // [P0-B] 原为无门段（Bot 任意档位可建定时任务）——收进注册表（feature scheduler / Bot≥L2）
    if (content.includes("<scheduleTask>")) {
      if (_admit("scheduleTask", "")) {
        const _stResult = parseScheduleTaskTag(content, username, charName, _cid);
        if (_stResult.found) {
          content = _stResult.cleanedContent;
        }
      } else {
        content = content.replace(/<scheduleTask>[\s\S]*?<\/scheduleTask>/gi, "");
      }
    }

    // 8. <delegate> — 主AI委派任务给子模式AI (P3)
    // A5: target 正则放宽 [\w-]+ → [^"]+ 支持中文 label；解析走 resolveSubMode 单一权威，
    //     allowCrossGroup=true——委派允许跨组（如 work 委派给 code 组子模式）。
    const _delegateMatch = content.match(
      /<delegate\s+target="([^"]+)"(?:\s+priority="(\w+)")?(?:\s+timeout="(\d+)")?>([\s\S]*?)<\/delegate>/i,
    );
    if (_delegateMatch && !_admit("delegate", `→${_delegateMatch[1]}`)) {
      // [P0-B] 拒绝三件套已由 _admit 记账；标签由下方块照剥
    } else if (_delegateMatch) {
      const [, _dlgTargetRaw, _dlgPriority, _dlgTimeout, _dlgTask] = _delegateMatch;
      try {
        const _memDir = ensureMemoryDir(username, charName);
        // 读取当前子模式作为委派源
        const _dlgSmPath = getYonbanConfigPath(username);
        const _dlgSmCfg = loadJsonFileIfExists(_dlgSmPath, { sub_modes: [], active_sub_mode: "前置任务专家" });
        const _dlgFromMode = resolveGenerationMode(args, username, charName, _cid);
        const _dlgFrom = resolveActiveSubModeId(_dlgSmCfg, _dlgFromMode, _cid);

        // 解析目标子模式（id∪label，跨组允许），归一到真实 id 存 _delegateCtx.to
        const _dlgTargetSm = resolveSubMode(_dlgSmCfg.sub_modes || [], _dlgTargetRaw.trim(), _dlgFromMode, true);
        const _dlgTarget = _dlgTargetSm ? _dlgTargetSm.id : _dlgTargetRaw.trim();

        // 从 chat_log 提取用户原话和对话上下文（信息保真：凛倾 2026-06-02 重设计确认）
        let _dlgUserMsg = "";
        let _dlgChatCtx = "";
        if (args?.chat_log && Array.isArray(args.chat_log)) {
          for (let i = args.chat_log.length - 1; i >= 0; i--) {
            if (args.chat_log[i].role === "user") {
              _dlgUserMsg = (args.chat_log[i].content || "").slice(0, V1_CONST.DELEGATE_USER_MSG_MAX);
              break;
            }
          }
          _dlgChatCtx = args.chat_log.slice(-V1_CONST.DELEGATE_CONTEXT_ENTRIES)
            .map(m => `[${m.role}] ${(m.content || "").slice(0, V1_CONST.DELEGATE_CONTEXT_ENTRY_MAX)}`)
            .join("\n");
        }

        // 创建委派上下文
        const _delegateCtx = {
          id: `dlg_${Date.now()}`,
          from: _dlgFrom,
          to: _dlgTarget,
          task: _dlgTask.trim(),
          priority: _dlgPriority || "normal",
          maxRounds: parseInt(_dlgTimeout) || 10,
          currentRound: 0,
          status: "active",
          createdAt: new Date().toISOString(),
          userMessage: _dlgUserMsg,
          chatContext: _dlgChatCtx,
          // bot 来源平台名取 request.extension.platform（壳构造的单源标识）——resolveRequestBotPermission
          //   只返回 {isBot, level} 无 platform 字段，原 botPerm.platform 恒 undefined → 永远记 "bot:unknown"。
          sourceChannel: args?.sourceChannel || (botPerm ? `bot:${args?.extension?.platform || "unknown"}` : "web"),
          // 回程地址（凛倾 07-09 委派回程唤醒）：bot 来源记下发起频道，<report> 完成时
          //   notifyBotDelegateReport 按此频道唤醒 bot 主动出话。各壳 extension 频道标识字段不同：
          //   discord/slack=channel_id，telegram/lark/wechat/wecom=chat_id，x=conv_id，
          //   line=session_id（getLineSessionId 返回 groupId/roomId/userId，即 pushMessage 目标本身），
          //   dingtalk=conversation_id。逐壳 extension 构造点亲核（2026-07-09）。
          sourceChannelId: args?.extension?.channel_id || args?.extension?.chat_id || args?.extension?.conv_id || args?.extension?.session_id || args?.extension?.conversation_id || "",
          chatId: _cid || "",
        };

        // 存入委派队列
        const _dlgQueuePath = path.join(_memDir, "work", "_delegate_queue.json");
        // 0716 T019 差集收编：损坏 → readJsonSafe 备份 .corrupt.bak 后抛 → 外层 catch(:delegate 处理失败)
        //   承接=本条委派失败报错可见（防原「空表+push+写回=既有委派整表覆盖为单条」）。
        const _dlgQueue = await readJsonSafe(_dlgQueuePath, []);
        _dlgQueue.push(_delegateCtx);
        const _dlgDir = path.dirname(_dlgQueuePath);
        if (!fs.existsSync(_dlgDir)) fs.mkdirSync(_dlgDir, { recursive: true });
        nicerWriteFileSync(_dlgQueuePath, JSON.stringify(_dlgQueue, null, 2));

        // bot 来源委派：中段执行者（凛倾 07-09 链路空洞修复）——web 闲置时没有任何生成轮
        // 会消费 H1 注入，任务会躺死队列；此处 fire-and-forget 起服务端 worker 直接执行
        // （runMemoryPresetAI 多轮），完成写回队列并经 §八 链唤醒 bot 回发。不阻塞 bot 当轮
        // 回复（bot 先答"已委派"，结果异步回程）。web 来源零变化（维持人驱动/auto-continue）。
        if (botPerm) {
          _runBotDelegateWorker(username, charName, _delegateCtx)
            .catch((e) => console.error(`[beilu-memory] bot 委派 worker 启动失败:`, e?.message || e));
        }

        // 触发子模式切换到目标（_dlgTargetSm 已在上方 resolveSubMode 解析）
        // bot 来源跳过切换（凛倾 07-09 指令链核查）：bot 请求无 chatid，writeActiveSubModeId(null)/
        //   setActiveMode(null)/applySubModePresetDefault(null) 全落 char 级·全局字段 = 污染同角色 web 窗口
        //   （getPromptHandler:221 已警告的形态）。bot 行为链不依赖这三写：模式由 extension.platform 派生、
        //   预设走全局 active_preset（[0716] 原 bindings.bot 已随「绑定」概念删除）、委派任务经 getPromptHandler _delegate_queue 注入（无条件分支）。
        if (_dlgTargetSm && !botPerm) {
          // T4 收口：write→save 走 updateYonbanConfig 串行锁（不覆盖并发写的其他字段）
          await updateYonbanConfig(username, (cfg) => {
            writeActiveSubModeId(cfg, _dlgTargetSm.modeGroup || "code", _dlgTarget, _cid);
            return cfg;
          }, { sub_modes: [], active_sub_mode: "前置任务专家" });
          // 生效模型（凛倾 2026-07-08）：委派切入目标子模式=一次性应用其默认预设（生成时无强切盖回）
          try { await applySubModePresetDefault(username, _dlgTargetSm, _cid); } catch (e) { console.warn(`[beilu-memory] 委派目标预设应用失败: ${e.message}`); }
          reply.extension._subModeSwitch = buildSubModeSwitchEvent({ from: _dlgFrom, to: _dlgTarget, sm: _dlgTargetSm, chatId: _cid, reason: "delegate" }); // 键收口 2026-07-13：契约单源构造器（modeGroup 从 sm 派生，原手拼缺失）
          // 如果目标子模式的 modeGroup 不同，也切换主模式
          if (_dlgTargetSm.modeGroup && _dlgTargetSm.modeGroup !== resolveGenerationMode(args, username, charName, _cid)) {
            // N38: 委派跨组转移只影响本对话线（active_modes_map[_cid]），不污染其他窗口
            setActiveMode(username, charName, _dlgTargetSm.modeGroup, _cid);
          }
        }
        opLog("delegate", `${_dlgFrom}→${_dlgTarget}`, { task: _dlgTask.slice(0, 100) }, "ok");
      } catch (e) {
        wbD(_cid, "memory", "handleReply:delegate", false, e.message, {});
        console.error(`[beilu-memory] delegate 处理失败:`, e.message);
      }
    }
    {
      const _beforeDlgClear = content.length;
      content = content.replace(/<delegate\s[^>]*>[\s\S]*?<\/delegate>/gi, "");
      wbT(_cid, "memory", "handleReply:delegateClear", { before: _beforeDlgClear, after: content.length });
    }

    // 8b. <parallelDelegate> — W57: 并行多任务委派
    const _pdMatch = content.match(/<parallelDelegate>([\s\S]*?)<\/parallelDelegate>/i);
    if (_pdMatch && !_admit("parallelDelegate", "")) {
      // [P0-B] 拒绝三件套已由 _admit 记账；标签由下方 replace 照剥
    } else if (_pdMatch) {
      wbT(_cid, "memory", "handleReply:parallelDelegate", { hasMatch: true });
      const _pdBody = _pdMatch[1];
      // [0726 同族漏改补齐] subMode 值放宽为 [^"]+（原 [\w-]+ = JS \w 仅 ASCII，002 现役 code 组 9 个子模式
      //   id 全是中文 → parallelDelegate 对它们静默不匹配）。<delegate> 的 target 已在 A5 放宽并注释"支持
      //   中文 label"（:2279-2282），本处是漏改的同族分支，非新设计。
      const _pdTasks = [..._pdBody.matchAll(/<task\s+subMode="([^"]+)">([\s\S]*?)<\/task>/gi)];
      if (_pdTasks.length > 0) {
        try {
          const _pdSmPath = getYonbanConfigPath(username);
          const _pdSmCfg = loadJsonFileIfExists(_pdSmPath, { sub_modes: [] });
          const _pdPresetsData = loadMemoryPresets(username, charName);
          const _pdMemData = loadMemoryData(username, charName, undefined, _cid);

          // 构建并行任务
          // 并发上限：map 产出 thunk（() => Promise），由 _runWithConcurrency 限流，非一次性全 fire
          const _pdPromises = _pdTasks.map(([, subModeId, taskPrompt]) => () => {
            const sm = (_pdSmCfg.sub_modes || []).find(s => s.id === subModeId);
            if (!sm?.presetName) {
              console.warn(`[parallelDelegate] 子模式"${subModeId}"无绑定预设，跳过`);
              return Promise.resolve({ subMode: subModeId, error: "无绑定预设" });
            }
            // O13 框架级修：预设双路查找（memory presets → beilu-preset 文件预设）已抽
            // 单一权威 _resolvePresetForSubMode（与 bot 委派 worker 共用，防散写）。
            const preset = _resolvePresetForSubMode(username, sm, _pdPresetsData);
            if (!preset) {
              console.warn(`[parallelDelegate] 预设"${sm.presetName}"未找到（memory presets 和文件预设均无匹配），跳过`);
              return Promise.resolve({ subMode: subModeId, error: "预设未找到" });
            }
            // 构造临时预设（注入任务prompt）
            const taskPreset = {
              ...preset,
              id: _delegId(`PD_${subModeId}`),
              prompts: [
                ...(preset.prompts || []),
                { role: "user", content: taskPrompt.trim(), enabled: true, builtin: false },
              ],
            };
            // [0726 多轮协议截断根修] 原写死 maxRounds:1 —— 对**多轮协议类预设**是致命的：P8 的协议是
            //   第1轮出 <searchQuery> → aiRunner 执行搜索并把结果 push 进 messages(:1261) → 第2轮 AI 才
            //   过滤提炼出 <searchResult>。maxRounds=1 时 aiRunner:1267 用**第1轮**内容直接收尾 →
            //   **搜索真的执行了，AI 永远看不到结果**，返回搜索前的空文本（P1 的 memorySearch 多轮同理）。
            //   改为跟随配置单源（retrieval.max_search_rounds 默认 5，与 P8 官方路径 getPromptHandler:1748
            //   不传 maxRounds 的行为一致）；单轮类预设本就在第1轮无工具标签时 break(:1164)，不受影响。
            return runMemoryPresetAI(username, charName, taskPreset, _pdMemData, charName, username, "", { signal: args?.generation_options?.signal, chatId: _cid }) // [2026-07-16] chatId 与 _pdMemData(:2222 带 _cid load) 同槽——runMemoryPresetAI 内 saveTablesData 按 cacheKey 写盘,漏传=写错槽丢改动
              .then(r => ({ subMode: subModeId, label: sm.label || subModeId, reply: r?.reply || "", status: "done" }))
              .catch(e => ({ subMode: subModeId, label: sm.label || subModeId, error: e.message, status: "error" }));
          });

          // 并行执行（并发上限来自 config.clone_concurrency，默认 0=无限多开；>0 才池限流）。不硬编码。
          const _pdLimit = _pdMemData?.config?.clone_concurrency ?? 0;
          const _pdResults = await _runWithConcurrency(_pdPromises, _pdLimit, args?.generation_options?.signal);

          // 存档结果（injected:true — 实际注入改走 pendingResults 同步路径，见下；
          // 文件仅留作记录，getPromptHandler 的文件注入分支因 injected=true 不再触发，避免双重注入）
          const _pdDir = ensureMemoryDir(username, charName);
          // ★ B2 corrId隔离: 文件名带会话维度，多会话并行委派各写各的不互相覆盖;
          //   _cid 为空(无会话上下文)时退回旧文件名，向后兼容。
          const _pdFileName = _cid ? `_parallel_results_${_cid}.json` : "_parallel_results.json";
          const _pdResultPath = path.join(_pdDir, "work", _pdFileName);
          const _pdDirPath = path.dirname(_pdResultPath);
          if (!fs.existsSync(_pdDirPath)) fs.mkdirSync(_pdDirPath, { recursive: true });
          nicerWriteFileSync(_pdResultPath, JSON.stringify({
            id: _delegId("pd"),
            results: _pdResults,
            createdAt: new Date().toISOString(),
            injected: true,
          }, null, 2));

          // 在extension中标记，让前端知道有并行结果
          reply.extension._parallelDelegateResults = _pdResults.map(r => ({
            subMode: r.subMode,
            label: r.label,
            status: r.status,
            preview: (r.reply || r.error || "").substring(0, 100),
          }));
          // {{clone_runtime}} 宏数据源:落多分身协作运行态快照(并行委派路径)
          writeCloneRuntimeSnapshot(username, charName, _cid, "parallel", _pdResults.map(r => ({
            label: r.label || r.subMode, status: r.status,
            summary: (r.reply || r.error || "").substring(0, 200),
          })));

          // #79修复：结果推入 pendingResults（与 clone W65 同路径），让 generation.mjs
          // 消费后自动继续。原仅写文件等下轮GetPrompt注入，无续轮触发源 → 主AI挂起到用户手动发消息。
          const _pdInjText = _pdResults.map(r =>
            `[${r.label || r.subMode}${r.status === "error" ? " (失败)" : ""}]\n${r.reply || r.error || "(无输出)"}`
          ).join("\n\n");
          ideClient.enqueuePendingResult({
            tool: "_parallel_results",
            // A-2：外层 success 派生自子结果（任一 error → false），不再写死 true，避免失败长得像成功（reality-gate 反虚报）。
            params: { taskCount: _pdResults.length, failedCount: _pdResults.filter(r => r.status === "error").length },
            result: { success: _pdResults.every(r => r.status !== "error"), result: `[并行委派结果 — ${_pdResults.length}个子任务]\n\n${_pdInjText}\n\n[/并行委派结果]` },
            chatid: _qcid,
            ownerUsername: username,
            timestamp: new Date().toISOString(),
          });
          // 广播 tool_results_ready（信息性，与 clone 一致；自动继续实由后端 generation.mjs 驱动）
          try {
            // [0716 T3对接首批] 改经 bus:broadcast.emit 出口。
            const _bcChatIdPd = args?.chatid || (args?.chat_name ? args.chat_name.replace("common_chat_", "") : "");
            if (_bcChatIdPd) {
              const _pdPendingCount = ideClient.getPendingResultCount({
                ownerUsername: username,
                chatid: _qcid,
              });
              await dispatch({ target: "bus:broadcast", verb: "emit", source: "yonban", payload: { chatid: _bcChatIdPd, event: {
                type: "tool_results_ready",
                payload: { count: _pdPendingCount, source: "parallel_delegate", readOnly: true, stopContinue: false },
              } } });
            }
          } catch (_bcErrPd) { /* 广播失败不影响主流程 */ }
        } catch (e) {
          wbD(_cid, "memory", "handleReply:parallelDelegateExec", false, e.message, {});
          console.error(`[parallelDelegate] 执行失败:`, e.message);
        }
      }
    }
    content = content.replace(/<parallelDelegate>[\s\S]*?<\/parallelDelegate>/gi, "");

    // ★ U5 reality-gate：验证 AI 声称"完成"时是否带了证据（确定性闸门）
    //
    // 任务类型感知（框架级，2026-06-16 凛倾点名修）：原闸门只认"改代码"证据
    // (grep + file:行号 + tsc/测试)，把调查/读表/配表类分身天然误判 NEEDS_WORK
    // （主AI被迫反复手动驳"这是误判"）。证据模型必须随任务类型分流——同一份"完成"
    // 对不同任务有不同的"算交差了"标准：
    //   - research(调查/采集/读/审计)：证据 = 落盘报告路径 + 读取了哪些文件(读取清单)
    //   - data   (配表/公式/xlsx)    ：证据 = 单元格/公式坐标 + 重算/校验结果
    //   - code   (改代码/实现/修)     ：证据 = grep 锚点 + 修改 file:行号 + tsc/测试(维持原标准)
    //   - null   (无法判型)           ：维持原 code 三件套标准(向后兼容，不误伤)
    //
    // 各类型的证据探针（命中=带了该类证据）。
    const _evidenceProbes = {
      grepProof: (t) => /grep|搜索|命中|匹配\s*\d|0\s*命中|\d+\s*(处|条|命中)|「grep:/.test(t),
      filePath: (t) => /[\w\-./\\]+\.\w{1,6}(:\d+)/.test(t) || /^\s*(修改|新增|改动|写入|创建)\s*[:：]/m.test(t),
      verification: (t) => /node\s*--\s*check|tsc|测试.*通过|pass|PASS|验证.*通过|单测|行为测|回归|syntax.?check/i.test(t),
      // research 证据：落盘报告路径(写入/已存/落盘 + .md/.json/.txt 路径，或显式"报告路径")。
      reportPath: (t) => /(落盘|已?存(入|到|于)?|写入|保存|输出到|报告路径|path)\s*[:：]?\s*[^\n]*\.(md|json|txt|csv|xlsx)/i.test(t) || /[\w\-./\\]+\.(md|json|txt|csv)\b/i.test(t),
      // research 证据：读取清单(读了哪些文件 / Read / 读取 + 文件名或数量)。
      readList: (t) => /读取|已读|Read\b|查阅|翻(阅|了)|读了\s*\d|阅读.*(文件|MD|代码)|读.*\d+\s*(个|份|处|文件)|[\w\-./\\]+\.\w{1,6}\b/i.test(t),
      // data 证据：单元格/公式坐标(A1/列行/sheet!/= 公式 或显式"单元格/坐标/列")。
      cellCoord: (t) => /\b[A-Z]{1,3}\d{1,4}\b|单元格|坐标|第\s*\d+\s*(行|列)|sheet|工作表|公式\s*[:：=]|=\s*[A-Z]+\(/i.test(t),
      // data 证据：重算/校验结果。
      recalcResult: (t) => /重算|校验|核对|复算|求和|合计|总和|总计|sum\b|验算|对账|结果\s*[:：=]\s*[\d.]/i.test(t),
    };
    // 任务类型 → 需要的证据键 + 缺失文案。
    const _evidenceSpec = {
      code: {
        keys: [["grepProof", "grep/搜索证据"], ["filePath", "修改文件路径(file:行号)"], ["verification", "验证结果(node--check/tsc/测试)"]],
        tolerance: 1, // 三件套缺 ≤1 算够（与原标准一致）
        hint: "请补充 grep 锚点 + 修改 file:line + 验证结果。",
      },
      research: {
        keys: [["reportPath", "落盘报告路径"], ["readList", "读取清单(读了哪些文件)"]],
        tolerance: 1, // 两项缺 ≤1（报告路径或读取清单至少有一项）
        hint: "请补充落盘报告路径 + 读取了哪些文件(读取清单)，调查类无需 grep/tsc。",
      },
      data: {
        keys: [["cellCoord", "单元格/公式坐标"], ["recalcResult", "重算/校验结果"]],
        tolerance: 1, // 两项缺 ≤1
        hint: "请补充单元格/公式坐标 + 重算/校验结果，配表类无需 grep/tsc。",
      },
    };
    const _checkClaimEvidence = (text, taskType = null) => {
      const _spec = _evidenceSpec[taskType] || _evidenceSpec.code; // 无法判型 → 维持 code 标准(向后兼容)
      if (!text) return { sufficient: false, taskType, missing: _spec.keys.map(k => k[1]), hint: _spec.hint };
      const has = {};
      const missing = [];
      for (const [probeKey, label] of _spec.keys) {
        const ok = _evidenceProbes[probeKey](text);
        has[probeKey] = ok;
        if (!ok) missing.push(label);
      }
      return { sufficient: missing.length <= _spec.tolerance, taskType, missing, has, hint: _spec.hint };
    };

    // 9. <report> — 子模式AI汇报委派结果 (P3)
    const _reportMatch = content.match(
      /<report(?:\s+status="(\w+)")?>([\s\S]*?)<\/report>/i,
    );
    if (_reportMatch && _admit("report", "")) {
      const [, _rptStatus, _rptContent] = _reportMatch;
      try {
        const _memDir = ensureMemoryDir(username, charName);
        const _rptQueuePath = path.join(_memDir, "work", "_delegate_queue.json");
        let _rptQueue = [];
        // [2026-08-01 批⑤危险#4] 同 :381 修——读失败≠空队列，报告正文写独立文件兜底保住。
        try { _rptQueue = JSON.parse(await fs.promises.readFile(_rptQueuePath, "utf-8")); } catch (rptQErr) {
          console.error(`[beilu-memory] <report> 队列读取失败(${rptQErr?.message})，报告写独立文件兜底`);
          try {
            const _rptFb = _rptQueuePath.replace(".json", `_orphan_report_${Date.now()}.json`);
            nicerWriteFileSync(_rptFb, JSON.stringify({ status: _rptStatus || "completed", report: _rptContent?.trim() || "", error: "queue_read_failed" }, null, 2));
          } catch {}
        }

        // 找到最新活跃委派
        const _rptActiveIdx = _rptQueue.findLastIndex(d => d.status === "active");
        if (_rptActiveIdx !== -1) {
          const _rptDelegate = _rptQueue[_rptActiveIdx];
          _rptDelegate.status = _rptStatus || "completed";
          _rptDelegate.completedAt = new Date().toISOString();
          _rptDelegate.reportInjected = false;
          // U5 reality-gate：report 声称 completed 但缺验证证据 → 追加 NEEDS_WORK 警告
          //   任务类型从委派目标角色(_rptDelegate.to) + 委派指令(_rptDelegate.task) + 报告正文推断，
          //   按类型出对应文案（调查/配表类不再被强求 grep/tsc）。
          let _rptText = _rptContent.trim();
          if (_rptDelegate.status === "completed") {
            const _rptType = inferCloneTaskType(_rptDelegate.to, `${_rptDelegate.task || ""}\n${_rptText}`);
            const _rptEv = _checkClaimEvidence(_rptText, _rptType);
            if (!_rptEv.sufficient) {
              _rptText += `\n\n⚠️ NEEDS_WORK: 报告声称完成但缺乏${_rptType === "research" ? "调查" : _rptType === "data" ? "配表" : "验证"}证据(${_rptEv.missing.join("、")})。${_rptEv.hint}`;
            }
          }
          _rptDelegate.report = _rptText;

          // 切回委派源模式
          const _rptSmPath = getYonbanConfigPath(username);
          const _rptSmCfg = loadJsonFileIfExists(_rptSmPath, { sub_modes: [], active_sub_mode: "前置任务专家" });
          const _rptSourceSm = (_rptSmCfg.sub_modes || []).find(s => s.id === _rptDelegate.from);
          if (_rptSourceSm) {
            // T4 收口：write→save 走 updateYonbanConfig 串行锁
            await updateYonbanConfig(username, (cfg) => {
              writeActiveSubModeId(cfg, _rptSourceSm.modeGroup || "code", _rptDelegate.from, _cid);
              return cfg;
            }, { sub_modes: [], active_sub_mode: "前置任务专家" });
            // 生效模型（凛倾 2026-07-08）：委派返回切回源子模式=一次性应用其默认预设（生成时无强切盖回）
            try { await applySubModePresetDefault(username, _rptSourceSm, _cid); } catch (e) { console.warn(`[beilu-memory] 委派返回预设应用失败: ${e.message}`); }
            reply.extension._subModeSwitch = buildSubModeSwitchEvent({ from: _rptDelegate.to, to: _rptDelegate.from, sm: _rptSourceSm, chatId: _cid, reason: "report_back" }); // 键收口 2026-07-13：契约单源构造器
            if (_rptSourceSm.modeGroup && _rptSourceSm.modeGroup !== resolveGenerationMode(args, username, charName, _cid)) {
              // N38: report 切回源组只影响本对话线
              setActiveMode(username, charName, _rptSourceSm.modeGroup, _cid);
            }
          }
          nicerWriteFileSync(_rptQueuePath, JSON.stringify(_rptQueue, null, 2));

          // bot 委派回程唤醒（凛倾 07-09「工作完需要有注入通知,然后ai去看,然后发送」）：
          //   报告已落队列（reportInjected=false）→ 通知来源壳出一轮主动生成——该轮 GetPrompt 走
          //   H2 注入报告（consume-once，与 web 同一注入/压缩机制），AI 读报告后组织回复发回来源频道。
          //   fire-and-forget：唤醒失败不影响报告落盘（用户下条消息的生成仍会注入报告，双保险）。
          if (_rptDelegate.sourceChannel && _rptDelegate.sourceChannel.startsWith("bot:")) {
            notifyBotDelegateReport({
              platform: _rptDelegate.sourceChannel.slice(4),
              username,
              charname: charName,
              channelId: _rptDelegate.sourceChannelId || "",
              delegateId: _rptDelegate.id,
            }).catch((e) => console.warn(`[beilu-memory] 委派回程唤醒失败:`, e?.message || e));
          }

          // ★ report完成时也触发taskOverlayComplete（W17临时对话清理）
          try {
            const _rptOverlayDir = getMemoryDir(username, charName);
            const _rptOverlayPath = path.join(_rptOverlayDir, "work", "_active_task_overlay.json");
            const _rptActiveOverlay = loadJsonFileIfExists(_rptOverlayPath);
            if (_rptActiveOverlay?.id) {
              reply.extension._taskOverlayComplete = {
                id: _rptActiveOverlay.id,
                result: _rptContent.trim().substring(0, 200) || "任务已完成",
                completedAt: new Date().toISOString(),
              };
              fs.unlinkSync(_rptOverlayPath);
            }
          } catch (_e) { /* non-critical */ }

        } else {
          // [BE-T3] 无活跃委派 fallback: 当作一次通用"任务完成"通知, 弹跨模式窗口
          console.warn(`[beilu-memory] report: 没有活跃委派, 触发 fallback 完成通知`);
          opLog("report", "orphan", { status: _rptStatus || "completed" }, "warn");
          reply.extension._crossModeNotification = reply.extension._crossModeNotification || {
            title: "任务完成报告",
            message: (_rptContent || "").trim().slice(0, 200) || "AI 提交了一份报告",
            targetTab: "smart",
            level: "info",
          };
          // 尝试完成最近的 taskOverlay
          try {
            const _rptOverlayDir = getMemoryDir(username, charName);
            const _rptOverlayPath = path.join(_rptOverlayDir, "work", "_active_task_overlay.json");
            const _rptActiveOverlay = loadJsonFileIfExists(_rptOverlayPath);
            if (_rptActiveOverlay?.id) {
              reply.extension._taskOverlayComplete = {
                id: _rptActiveOverlay.id,
                result: (_rptContent || "").trim().substring(0, 200) || "任务已完成",
                completedAt: new Date().toISOString(),
              };
              try { fs.unlinkSync(_rptOverlayPath); } catch {}
            }
          } catch { /* non-critical */ }
        }
      } catch (e) {
        wbD(_cid, "memory", "handleReply:report", false, e.message, {});
        console.error(`[beilu-memory] report 处理失败:`, e.message);
      }
    }
    content = content.replace(/<report[\s\S]*?<\/report>/gi, "");

    // 10. <approval> — AI请求用户审批 (P3)
    const _approvalMatch = content.match(
      /<approval(?:\s+type="(\w+)")?(?:\s+id="([^"]*)")?>([\s\S]*?)<\/approval>/i,
    );
    if (_approvalMatch && _admit("approval", "")) {
      const [, _aprType, _aprId, _aprContent] = _approvalMatch;
      try {
        let _aprData;
        try {
          _aprData = JSON.parse(_aprContent);
        } catch {
          _aprData = { title: "审批请求", description: _aprContent.trim() };
        }

        const _approvalItem = {
          id: _aprId || `apr_${Date.now()}`,
          type: _aprType || "confirm",
          ..._aprData,
          status: "pending",
          createdAt: new Date().toISOString(),
          // 0715 断链修：记录发起会话——resolveWorkApproval 决议后据此触发续轮
          //（此前决议只写 _pending_results.json 等"下一轮"，但无人触发下一轮=点了同意零反馈，
          //  与 IDE 审批 0714 修复前同病）。旧存量项无此字段=保持原行为（等用户发言）。
          chatid: _cid || "",
        };

        // 存入审批队列
        const _memDir = ensureMemoryDir(username, charName);
        const _aprQueuePath = path.join(_memDir, "work", "_approval_queue.json");
        // 生产#5/半修陷阱：此 add 原裸写 → defeat 了 setDataActions M4(:2748 同名 _approval_queue) 的锁，
        //   本模块 add ↔ setDataActions resolve 并发会 lost-update。read-modify-write 整段进 withFileLock 串行。
        await withFileLock(_aprQueuePath, () => {
          // 0716 T019 差集收编：损坏 → 备份后抛（原 catch{} 完全静默=既有审批队列覆盖为单条）→
          //   锁 finally 释放 → 外层 catch(:approval 处理失败) 承接可见。
          const _aprQueue = readJsonSafeSync(_aprQueuePath, []);
          _aprQueue.push(_approvalItem);
          const _aprDir = path.dirname(_aprQueuePath);
          if (!fs.existsSync(_aprDir)) fs.mkdirSync(_aprDir, { recursive: true });
          nicerWriteFileSync(_aprQueuePath, JSON.stringify(_aprQueue, null, 2));
        });

        // W17: 跨模式通知 — 用户可能在其他Tab，需要通知
        reply.extension._crossModeNotification = {
          title: "需要确认",
          message: _approvalItem.title || _approvalItem.description?.slice(0, 60) || "工作模式有操作需要你确认",
          targetTab: "work",
          level: "warning",
        };
        opLog("approval", _approvalItem.title || "untitled", {}, "ok");
      } catch (e) {
        wbD(_cid, "memory", "handleReply:approval", false, e.message, {});
        console.error(`[beilu-memory] approval 处理失败:`, e.message);
      }
    }
    content = content.replace(/<approval[\s\S]*?<\/approval>/gi, "");

    // 10b. <progress> — 任务进度更新 (全智能设计P2-1)
    // 格式: <progress step="2" total="4" message="正在翻译第3段"/>
    //   或: <progress>{"current":2,"total":4,"message":"..."}</progress>
    const _progressMatch = content.match(/<progress([^>]*)(?:\/>|>([\s\S]*?)<\/progress>)/i);
    if (_progressMatch) {
      try {
        const _attrs = _progressMatch[1] || "";
        const _body = _progressMatch[2] || "";
        let _progData = {};
        if (_body.trim().startsWith("{")) {
          try { _progData = JSON.parse(_body); } catch { _progData = { message: _body.trim() }; }
        } else if (_body.trim()) {
          _progData = { message: _body.trim() };
        }
        const _stepAttr = _attrs.match(/step\s*=\s*"(\d+)"/i);
        const _totalAttr = _attrs.match(/total\s*=\s*"(\d+)"/i);
        const _msgAttr = _attrs.match(/message\s*=\s*"([^"]*)"/i);
        if (_stepAttr) _progData.current = parseInt(_stepAttr[1]);
        if (_totalAttr) _progData.total = parseInt(_totalAttr[1]);
        if (_msgAttr) _progData.message = _msgAttr[1];
        reply.extension._progress = { ..._progData, at: new Date().toISOString() };
        opLog("progress", `${_progData.current || "?"}/${_progData.total || "?"} ${_progData.message || ""}`.slice(0, 40), {}, "ok");
      } catch (e) {
        wbD(_cid, "memory", "handleReply:progress", false, e.message, {});
        console.error(`[beilu-memory] progress 解析失败:`, e.message);
      }
    }
    content = content.replace(/<progress[\s\S]*?(?:\/>|<\/progress>)/gi, "");

    // 10c. <needHelp> — AI主动求助, 弹跨模式通知 (全智能设计P2-1)
    const _needHelpMatch = content.match(/<needHelp[^>]*>([\s\S]*?)<\/needHelp>/i);
    if (_needHelpMatch) {
      const _hMsg = _needHelpMatch[1].trim().slice(0, 200);
      reply.extension._crossModeNotification = {
        title: "需要你的帮助",
        message: _hMsg || "AI 需要你的帮助",
        targetTab: "smart",
        level: "warning",
      };
      opLog("needHelp", _hMsg.slice(0, 40), {}, "ok");
    }
    content = content.replace(/<needHelp[\s\S]*?<\/needHelp>/gi, "");

    // ★ FT6 D4：跨 chatId 广播跨模式通知 — work/code 在独立 chatId 产出的 report 完成 /
    //   needHelp 求助通知, 经 broadcastCrossChatEvent 推到源 chat(全智能窗口), 替代前端轮询。
    //   producing chatId 自身经普通 message_replaced→messageList:handleCrossModeNotification 已弹;
    //   此处仅补「源 chat 跨窗口」一向(approval 已在 L1270 同款广播, 这里覆盖 report/needHelp)。
    if (reply.extension._crossModeNotification && _cid) {
      try {
        // [0716 T3对接首批] 改经 bus:broadcast.emitCross 出口（顶层 notification 字段=历史契约形状，出口透传）。
        await dispatch({ target: "bus:broadcast", verb: "emitCross", source: "yonban", payload: { chatid: _cid, event: {
          type: "cross_mode_task_update",
          subtype: "cross_mode_notification",
          notification: reply.extension._crossModeNotification,
        } } });
      } catch (_bcECmn) { /* 广播失败不阻塞主回复 */ }
    }

    // 11. <createFlowGroup> — AI自动创建流程组 (P4)
    const _flowGroupMatch = content.match(
      /<createFlowGroup>([\s\S]*?)<\/createFlowGroup>/i,
    );
    if (_flowGroupMatch && _admit("createFlowGroup", "")) {
      try {
        const _fgData = JSON.parse(_flowGroupMatch[1]);
        const _fgName = _fgData.name || `flow_${Date.now()}`;
        const _memDir = ensureMemoryDir(username, charName);

        // 源/模型快照（凛倾 2026-07-15「不需要AI决定api——直接复制现在正在工作的那个子模式里面的」）：
        //   建组时把当前活跃子模式的源/模型配置整组复制进组级 api_source/model_params——AI JSON 里的
        //   任何源/模型字段一律不采信（不读）。canonical 键对齐子模式覆盖链（getPromptHandler:277 注释），
        //   B18 同则：model_params 副本权威，无副本从扁平字段归一构造。子模式全空 → 快照存空（跟随全局）。
        //   消费端=getPromptHandler 流程组快照回退（执行该组时子模式覆盖整组为空才启用，N36 原子单元）；
        //   用户可改=前端 _flowGroupCreated 弹窗 / 组详情面板 → updateFlowGroup。
        let _fgApiSource = "", _fgModelSnap = null;
        try {
          const _fgSmCfg = loadJsonFileIfExists(getYonbanConfigPath(username), { sub_modes: [] });
          const _fgSmId = resolveActiveSubModeId(_fgSmCfg, resolveGenerationMode(args, username, charName, _cid), _cid);
          const _fgSm = (_fgSmCfg.sub_modes || []).find((m) => m.id === _fgSmId);
          if (_fgSm) {
            const _fgMp = (_fgSm.model_params && typeof _fgSm.model_params === "object") ? _fgSm.model_params : null;
            _fgModelSnap = _fgMp ? JSON.parse(JSON.stringify(_fgMp)) : {
              ...(_fgSm.modelName ? { model: _fgSm.modelName } : {}),
              ...(_fgSm.apiSource ? { api_source: _fgSm.apiSource } : {}),
              ...(_fgSm.temperature !== undefined ? { temperature: _fgSm.temperature } : {}),
              ...(_fgSm.top_p !== undefined ? { top_p: _fgSm.top_p } : {}),
              ...(_fgSm.top_k !== undefined ? { top_k: _fgSm.top_k } : {}),
              ...(_fgSm.min_p !== undefined ? { min_p: _fgSm.min_p } : {}),
              ...((_fgSm.maxTokens || _fgSm.max_tokens) ? { max_tokens: _fgSm.maxTokens || _fgSm.max_tokens } : {}),
              ...(_fgSm.promptPostProcessing ? { prompt_post_processing: _fgSm.promptPostProcessing } : {}),
              ...(_fgSm.claudePrefillMode ? { claude_prefill_mode: _fgSm.claudePrefillMode } : {}),
              ...(_fgSm.prefillEnabled !== undefined ? { prefill_enabled: _fgSm.prefillEnabled } : {}),
              // thinking 快照键已删（2026-08-01 收口到 AI 源面板 per-源单点，快照不再携带 thinking）
            };
            if (Object.keys(_fgModelSnap).length === 0) _fgModelSnap = null; // 子模式零配置=不落死快照
            _fgApiSource = _fgModelSnap ? ((_fgModelSnap.api_source ?? _fgModelSnap.apiSource) || "") : "";
          }
        } catch (_fgSnapErr) {
          console.warn(`[beilu-memory] createFlowGroup: 源/模型快照读取失败（组照常创建，跟随全局）: ${_fgSnapErr.message}`);
        }

        // 1. 保存流程组JSON到 work/workflows/
        const _wfDir = path.join(_memDir, "work", "workflows");
        if (!fs.existsSync(_wfDir)) fs.mkdirSync(_wfDir, { recursive: true });
        const _fgSafeName = sanitizeFilename(_fgName);
        const _fgPath = path.join(_wfDir, `${_fgSafeName}.json`);
        const _flowGroup = {
          name: _fgName,
          description: _fgData.description || "",
          steps: _fgData.steps || [],
          auto_advance: _fgData.auto_advance ?? true,
          // B6 反虚报闸：true=推进前要求本轮回复含非空 <completionVerify> 标签（步骤自证完成）；false=旧行为(仅查非空非错误)。
          flow_completion_gate: _fgData.flow_completion_gate ?? true,
          approval_before: _fgData.approval_before || [],
          api_source: _fgApiSource,
          model_params: _fgModelSnap,
          created_at: new Date().toISOString(),
          created_by: "ai",
        };
        nicerWriteFileSync(_fgPath, JSON.stringify(_flowGroup, null, 2));

        // 2. 为每个步骤创建预设（如果有prompt内容）— BUG-8: 改用 presetBridge 新格式
        let _presetsCreated = 0;
        if (Array.isArray(_fgData.steps)) {
          for (const _step of _fgData.steps) {
            if (_step.preset_name && _step.prompt) {
              try {
                if (!presetExists(username, _step.preset_name)) {
                  const _defaultOrder = [
                    { identifier: "main", enabled: true }, { identifier: "personaDescription", enabled: true },
                    { identifier: "worldInfoBefore", enabled: true }, { identifier: "charDescription", enabled: true },
                    { identifier: "charPersonality", enabled: true }, { identifier: "scenario", enabled: true },
                    { identifier: "nsfw", enabled: true }, { identifier: "worldInfoAfter", enabled: true },
                    { identifier: "dialogueExamples", enabled: true }, { identifier: "chatHistory", enabled: true },
                    { identifier: "jailbreak", enabled: true },
                  ];
                  const _presetJson = {
                    prompts: [
                      { name: "Main Prompt", system_prompt: true, role: "system", content: _step.prompt, identifier: "main", forbid_overrides: false, injection_position: 0, injection_depth: DEFAULT_INJECTION_DEPTH, injection_order: 100 },
                      { name: "NSFW Prompt", system_prompt: true, role: "system", content: "", identifier: "nsfw", forbid_overrides: false, injection_position: 0, injection_depth: DEFAULT_INJECTION_DEPTH, injection_order: 100 },
                      { name: "Jailbreak", system_prompt: true, role: "system", content: "", identifier: "jailbreak", forbid_overrides: false, injection_position: 0, injection_depth: DEFAULT_INJECTION_DEPTH, injection_order: 100 },
                      { identifier: "personaDescription", name: "Persona Description", system_prompt: true, marker: true },
                      { identifier: "scenario", name: "Scenario", system_prompt: true, marker: true },
                      { identifier: "charDescription", name: "Char Description", system_prompt: true, marker: true },
                      { identifier: "charPersonality", name: "Char Personality", system_prompt: true, marker: true },
                      { identifier: "worldInfoBefore", name: "World Info (before)", system_prompt: true, marker: true },
                      { identifier: "worldInfoAfter", name: "World Info (after)", system_prompt: true, marker: true },
                      { identifier: "chatHistory", name: "Chat History", system_prompt: true, marker: true },
                      { identifier: "dialogueExamples", name: "Chat Examples", system_prompt: true, marker: true },
                    ],
                    prompt_order: [
                      { character_id: 100000, order: _defaultOrder.map(o => ({ ...o })) },
                      { character_id: 100001, order: _defaultOrder.map(o => ({ ...o })) },
                    ],
                    temperature: _step.temperature ?? 0.7,
                  };
                  createBeiluPreset(username, _step.preset_name, _presetJson, `[${_fgName}] ${_step.label || _step.mode || ""}`);
                  _presetsCreated++;
                }
              } catch (_pErr) {
                console.warn(`[beilu-memory] createFlowGroup: 创建预设失败 ${_step.preset_name}:`, _pErr.message);
              }
            }
          }
        }

        // filename/api_source/model：前端通知弹窗（websocket _maybeHandleFlowGroupCreated）显示当前快照
        //   并经 updateFlowGroup 按 filename 改写（凛倾 2026-07-15「ai新建之后需要进行通知,弹出是否更改模型或者api」）。
        reply.extension._flowGroupCreated = {
          name: _fgName, path: _fgPath, filename: `${_fgSafeName}.json`, presetsCreated: _presetsCreated,
          api_source: _fgApiSource, model: _fgModelSnap ? ((_fgModelSnap.model ?? _fgModelSnap.modelName) || "") : "",
        };
      } catch (e) {
        wbD(_cid, "memory", "handleReply:createFlowGroup", false, e.message, {});
        console.error(`[beilu-memory] createFlowGroup 解析失败:`, e.message);
      }
    }
    content = content.replace(/<createFlowGroup>[\s\S]*?<\/createFlowGroup>/gi, "");

    // 11b. W61: <captureControl> — AI调节截图频率/窗口选择（F1/F2需求）
    // M3(2026-06-12): 感知模式 AI 自己输出指令切换通道（凛倾「要么ai自己输出指令切换,要么用户自己切换」）。
    //   用户侧已通（前端 radio → /api/eye/config）；AI 侧走本既有 captureControl 通道——感知模式与
    //   截图频率/窗口同属用户级 eye_config 持久偏好，是同一类配置，不另起第二个 AI 标签。
    //   perceptionMode 枚举校验与 endpoints.mjs:590 /api/eye/config 同口径（passive/active/quiet），
    //   AI 给非法值忽略，禁旁路写非法态。
    {
      const _ccMatch = content.match(/<captureControl>([\s\S]*?)<\/captureControl>/i);
      if (_ccMatch && _admit("captureControl", "")) {
        try {
          const _ccData = JSON.parse(_ccMatch[1].trim());
          // 保存到用户eye_config
          const _eyePath = getEyeConfigPath(username);
          const _eyeConfig = loadJsonFileIfExists(_eyePath, {});
          // canonical 字段口径 = DEFAULT_EYE_CONFIG(injection_state.mjs:235-237) + /api/eye/config(endpoints.mjs:587-588)：
          //   截图频率 = captureFrequency（秒，0=禁用自动截图，即"关闭截图"语义，无独立 enabled 开关字段）
          //   目标窗口 = captureWindow（null=全屏，与 endpoints.mjs:588 同口径 `|| null`）
          //   旧的 targetWindow/captureEnabled 是孤儿键（全库无消费方），AI 写后端读不到，已收口到 canonical。
          // AI 自主 gate(凛倾 2026-07-09"ai自主需要可以设置"):每字段过用户 eye_config.aiAllow* 开关,
          //   关=忽略该字段(用户主权)。!== false 语义=旧配置无键默认放行(与 DEFAULT_EYE_CONFIG 一致,零迁移)。
          //   _ccApplied 收集实际生效项 → 下方反馈广播(用户可见,不静默)。
          const _ccApplied = {};
          // frequency 校验(2026-07-10 审计D8修):此前零校验,负数/NaN 直写盘——与 /api/eye/config:1059 的
          // Math.max(0,…) 同键不同口径,且 gameCompanion 运行中对表会吃到负 base。AI 通道语义=非法值忽略(块头注释成真)。
          const _ccFreq = Number(_ccData.frequency);
          if (_ccData.frequency !== undefined && Number.isFinite(_ccFreq) && _ccFreq >= 0 && _eyeConfig.aiAllowFrequency !== false) {
            _eyeConfig.captureFrequency = _ccFreq;
            _ccApplied.frequency = _ccFreq;
          }
          if (_ccData.window !== undefined && _eyeConfig.aiAllowWindow !== false) {
            _eyeConfig.captureWindow = _ccData.window || null;
            _ccApplied.window = _ccData.window || null;
          }
          // M3: 感知模式三态（与 /api/eye/config :590 同枚举校验，非法值忽略不写）
          if ((_ccData.perceptionMode === "passive" || _ccData.perceptionMode === "active" || _ccData.perceptionMode === "quiet") && _eyeConfig.aiAllowPerceptionMode !== false) {
            _eyeConfig.perceptionMode = _ccData.perceptionMode;
            _ccApplied.perceptionMode = _ccData.perceptionMode;
          }
          // captureNow 立即截一张(凛倾 2026-07-13"1做":此前 AI 只能调参等定时点,无"看一眼"动作):
          //   写既有 _gc_capture_request.json(与 gameCompanion 同 producer 形状,消费端 autoCapture 5s 轮询零改动;
          //   去重 L1/L2 与黑白名单安全门照常)。删除契约=写入方负责 unlink(endpoints getdata 只读不删):
          //   TTL 秒数走 eye_config.captureRequestTtlSec 单源(默认10,覆盖≥一个轮询周期)。已存在标记=陪伴轮
          //   在途请求,不重写不另设删除(其写入方 gameCompanion 自己 unlink,双写会互删打架)。
          if (_ccData.captureNow === true && _eyeConfig.aiAllowCaptureNow !== false) {
            try {
              const _cnPath = getGcCaptureRequestPath(username);
              if (!fs.existsSync(_cnPath)) {
                saveJsonFile(_cnPath, { requestedAt: Date.now(), source: "captureNow" });
                const _cnTtl = Number(_eyeConfig.captureRequestTtlSec);
                setTimeout(() => { try { fs.unlinkSync(_cnPath); } catch { /* 已被消费方轮次清理:无害 */ } },
                  (Number.isFinite(_cnTtl) && _cnTtl > 0 ? _cnTtl : 10) * 1000);
                _ccApplied.captureNow = true;
              }
            } catch (_cnErr) { wbD(_cid, "memory", "handleReply:captureNow", false, _cnErr.message, {}); }
          }
          // [凛倾 0722 散写收口] 原状:本通道 saveJsonFile 直写盘+手抄"清缓存"副作用(清理失败=该 user
          //   缓存持续 stale,旧注释自认);web 写口 endpoints.mjs:1131 却走 saveEyeConfig(写盘+缓存刷新同点)
          //   ——同一配置两套写语义,与 petEnabled 散写同病。现 AI 写口统一走 saveEyeConfig funnel,
          //   缓存一致性由 funnel 内建,无第二套手抄副作用。import 失败走外层 catch=本轮 captureControl
          //   整体不生效(与 JSON 解析失败同路径,不半写)。
          const _eyeInjMod = await import(new URL("../../screenshot/injection_state.mjs", import.meta.url).href);
          _eyeInjMod.saveEyeConfig(username, __projectRoot, _eyeConfig);
          // AI 自主动作反馈(凛倾 2026-07-09"设置区给反馈…停留等等"):有实际生效项且 aiFeedbackPanel 未关
          //   → WS capture_control_applied {applied,dwellMs,at}。范式同 orb_message(:796)。
          //   dwellMs 由本处读用户值随包下发(缺键=DEFAULT_EYE_CONFIG 出厂值)——前端纯消费零副本。
          //   消费端: websocket.mjs case → beilu:capture-control-applied → companion 面板提示+陪伴消息行。
          if (Object.keys(_ccApplied).length && _eyeConfig.aiFeedbackPanel !== false) {
            try {
              // [0716 T3对接首批] 改经 bus:broadcast.emit 出口（dwell 默认值解析逻辑原样保留）。
              const _bcChatIdCc = args?.chatid || (args?.chat_name ? args.chat_name.replace("common_chat_", "") : "");
              if (_bcChatIdCc) {
                let _ccDwell = Number(_eyeConfig.aiFeedbackDwellMs);
                if (!Number.isFinite(_ccDwell) || _ccDwell < 0) {
                  try {
                    const _eyeDefMod = await import(new URL("../../screenshot/injection_state.mjs", import.meta.url).href);
                    _ccDwell = Number(_eyeDefMod.DEFAULT_EYE_CONFIG?.aiFeedbackDwellMs);
                  } catch { _ccDwell = NaN; }
                }
                await dispatch({ target: "bus:broadcast", verb: "emit", source: "yonban", payload: { chatid: _bcChatIdCc, event: {
                  type: "capture_control_applied",
                  payload: { applied: _ccApplied, dwellMs: Number.isFinite(_ccDwell) ? _ccDwell : 0, at: Date.now() },
                } } });
              }
            } catch (_ccBcErr) { /* 反馈广播失败不影响配置落盘 */ }
          }
        } catch (e) {
          wbD(_cid, "memory", "handleReply:captureControl", false, e.message, {});
          console.warn("[beilu-memory] captureControl解析失败:", e.message);
        }
      }
      content = content.replace(/<captureControl>[\s\S]*?<\/captureControl>/gi, "");
    }

    // 11c 已删（2026-07-16）：<browserAction> 队列随 beilu-browser 插件整体移除
    //   （写入的 _browser_actions_queue.json 全库无读取方，插件已删=悬空 producer）。

    // 11d. <mcpConnect> — AI 只能提出请求；导入/挂载/命令批准均由 MCP 面板现有用户流程承担。
    {
      const _mcMatch = content.match(/<mcpConnect>([\s\S]*?)<\/mcpConnect>/i);
      if (_mcMatch && _admit("mcpConnect", "")) {
        try {
          const _mcRequest = await createMcpConnectRequest({
            username,
            chatId: _cid || "",
            rawText: _mcMatch[1],
            source: "ai:mcpConnect",
          });
          reply.extension._mcpConnectRequest = _mcRequest;
          // 只广播“数据已变化”信号；面板按 chatId 过滤后重拉服务端记录，不在 WS 携带配置或触发导入。
          const _mcBroadcast = await dispatch({
            target: "bus:broadcast",
            verb: "emitAll",
            source: "yonban",
            payload: {
              username: username !== "_default" ? username : undefined,
              event: {
                type: "mcp_connect_requests_changed",
                payload: {
                  requestId: _mcRequest.requestId,
                  chatId: _mcRequest.chatId,
                  status: _mcRequest.status,
                },
              },
            },
          });
          if (!_mcBroadcast?.ok) {
            console.warn("[beilu-memory] mcpConnect 请求已登记，但刷新广播失败:", _mcBroadcast?.error?.msg);
          }
          wbD(_cid, "memory", "handleReply:mcpConnect:pendingReview", true, "MCP 请求已登记，等待用户在面板审查", {
            requestId: _mcRequest.requestId,
            validationError: _mcRequest.validationError,
          });
        } catch (e) {
          wbD(_cid, "memory", "handleReply:mcpConnect", false, e.message, {});
          console.warn("[beilu-memory] mcpConnect请求登记失败:", e.message);
        }
      }
      content = content.replace(/<mcpConnect>[\s\S]*?<\/mcpConnect>/gi, "");
    }

    // 12. <contextClean> — AI自主清理上下文中的冗余内容（立即执行，直接改chatLog）
    // [0730] AI自动清理限制：① token<阈值时禁止清理（防缓存失效）② 禁止删除用户原话
    {
      const _cleanRegex = /<contextClean>([\s\S]*?)<\/contextClean>/gi;
      let _cleanMatch;
      const _cleanActions = [];
      while ((_cleanMatch = _cleanRegex.exec(content)) !== null) {
        const _cleanCmd = _cleanMatch[1].trim();
        _cleanActions.push(_cleanCmd);
      }
      if (_cleanActions.length > 0 && _admit("contextClean", `×${_cleanActions.length}`)) {
        // 清理闸门直接消费产生本条回复的同一 prompt_struct；不另建跨轮状态，也不重算 token。
        // 最低占用复用 token_reminder 现有首级提醒阈值：提醒何时允许 AI 清理，与 TOKEN_WARNING 同一配置。
        const _turnTokenStatus = args?.prompt_struct?.plugin_prompts?.["beilu-memory"]?.extension?.code_token_status;
        const _cleanTrCfg = {
          ...DEFAULT_TOKEN_REMINDER,
          ...(loadMemoryData(username, charName, undefined, _qcid)?.config?.token_reminder || {}),
        };
        const _cleanThresholds = Array.isArray(_cleanTrCfg.thresholds) ? _cleanTrCfg.thresholds : [];
        const _cleanMinPercent = _cleanThresholds
          .map((item) => Number(item?.percent))
          .filter(Number.isFinite)
          .reduce((min, value) => Math.min(min, value), Infinity);
        const _cleanStatusValid = _turnTokenStatus
          && Number.isFinite(_turnTokenStatus.percentage)
          && Number.isFinite(_turnTokenStatus.used)
          && Number.isFinite(_turnTokenStatus.limit)
          && Number.isFinite(_cleanMinPercent);
        if (!_cleanStatusValid || _turnTokenStatus.percentage < _cleanMinPercent) {
          const _cleanBlockReason = _cleanStatusValid
            ? `当前占用${_turnTokenStatus.percentage}%（${_turnTokenStatus.used}/${_turnTokenStatus.limit}），低于首级提醒阈值${_cleanMinPercent}%`
            : "本轮没有有效的 Token 状态，无法判定是否达到清理阈值";
          diag.warn(`contextClean: 拒绝AI清理——${_cleanBlockReason}（防缓存失效）`);
          ideClient.enqueuePendingResult({
            tool: "_context_clean_blocked",
            params: {},
            result: { success: false, error: _cleanStatusValid
              ? `🚫 上下文当前占用约 ${_turnTokenStatus.percentage}%（${Math.round(_turnTokenStatus.used / 1000)}K/${Math.round(_turnTokenStatus.limit / 1000)}K），低于首级 Token 提醒阈值 ${_cleanMinPercent}%。请继续工作，不需要清理。`
              : "🚫 本轮没有有效的 Token 状态，已拒绝自动清理；请先确认 Token 统计链正常。" },
            chatid: _qcid, timestamp: new Date().toISOString(),
          });
          content = content.replace(/<contextClean>[\s\S]*?<\/contextClean>/gi, "");
        } else {
        diag.log(`contextClean: 检测到${_cleanActions.length}个清理指令: ${_cleanActions.join(", ")}, chatid=${args?.chatid || "(无)"}`);
        // 立即执行：删除语义=不发送掩码（_hidden），留盘可逆，仅 requestBuilder:97 过滤不送 AI
        try {
          const _chatOpsPath = path.join(__pluginDir, "..", "..", "shells", "beilu-chat", "src", "lib", "chatOps.mjs");
          const _chatOps = await import(pathToFileURL(_chatOpsPath).href);
          const _chatId = args?.chatid || (args?.chat_name ? args.chat_name.replace("common_chat_", "") : "");
          const _totalLen = _chatId ? await _chatOps.GetChatLogLength(_chatId) : 0;
          const _chatLog = _totalLen > 0 ? await _chatOps.GetChatLog(_chatId, 0, _totalLen) : null;
          if (_chatLog && Array.isArray(_chatLog)) {
            let _cleanedCount = 0;
            const _ideTagRe = /<ideToolCall\s+tool="([^"]*)"[^>]*>[\s\S]*?<\/ideToolCall>/gi;
            const _fileOpRe = /<file_op\s+[^>]*tool="([^"]*)"[^>]*>[\s\S]*?<\/file_op>/gi;
            const _applyClean = async (_idxs, _isPurge, _label) => {
              if (!_idxs || _idxs.length === 0) return 0;
              // [0730] 用户原话保护：AI清理禁止删除/隐藏 role="user" 的消息
              const _protectedCount = _idxs.filter((i) => _chatLog[i]?.role === "user").length;
              if (_protectedCount > 0) {
                _idxs = _idxs.filter((i) => _chatLog[i]?.role !== "user");
                diag.warn(`contextClean ${_label}: 保护了${_protectedCount}条用户原话不被清理`);
              }
              if (_idxs.length === 0) return 0;
              if (_isPurge) {
                const { markDeleted } = await import("../../hide/chatEntryUtils.mjs"); // T8·回切：改指 yonban 新位实现体
                let _n = 0;
                for (const _di of _idxs) {
                  if (!_chatLog[_di]) continue;
                  markDeleted(_chatLog[_di], "ai_purge");
                  _n++;
                }
                if (_n > 0 && _chatId) {
                  try {
                    const { saveChat, chatMetadatas } = await import("../../../../../public/parts/shells/beilu-chat/src/lib/chatStorage.mjs");
                    const _cd = chatMetadatas?.get(_chatId);
                    if (_cd?.chatMetadata) {
                      const _log = _cd.chatMetadata.chatLog;
                      let _lastActive = null;
                      for (let _li = _log.length - 1; _li >= 0; _li--) { if (!_log[_li]?.extension?._deleted) { _lastActive = _log[_li]; break; } }
                      _cd.chatMetadata.timeLines = _lastActive ? [_lastActive] : [];
                      _cd.chatMetadata.timeLineIndex = 0;
                      const { timeSlice_t } = await import("../../../../../public/parts/shells/beilu-chat/src/lib/models.mjs");
                      _cd.chatMetadata.LastTimeSlice = _lastActive ? _lastActive.timeSlice : new timeSlice_t();
                    }
                    await saveChat(_chatId);
                  } catch {}
                }
                diag.log(`contextClean purge ${_label}: 标记删除${_n}条（数据保留，可恢复）`);
                return _n;
              }
              // T3 定位：按稳定 entry.id 锚定（hideMessages reload 后按 id 重定位下标，防并发 TOCTOU 漂移）；缺 id(legacy) 回退入参下标
              const _ids = _idxs.map((i) => _chatLog[i]?.id);
              // T4：AI 主动隐藏 → by=ai, reason=contextClean（供 UI 区分 ai/auto/user）
              await _chatOps.hideMessages(_chatId, _idxs, true, { ...(_ids.every(Boolean) ? { ids: _ids } : {}), meta: { by: "ai", reason: "contextClean" } });
              diag.log(`contextClean ${_label}: 隐藏(可逆,不发送)${_idxs.length}条`);
              return _idxs.length;
            };
            for (const _cmd of _cleanActions) {
              const _isPurge = _cmd.startsWith("purge:");
              const _innerCmd = _isPurge ? _cmd.substring("purge:".length).trim() : _cmd;
              if (_innerCmd === "tool_results:all") {
                const _delIndices = [];
                for (let i = 0; i < _chatLog.length; i++) {
                  if (isIdeToolResultMsg(_chatLog[i])) {
                    _delIndices.push(i);
                  }
                }
                _cleanedCount += await _applyClean(_delIndices, _isPurge, "tool_results:all");
                ideClient.clearReadCache(_qcid);
              } else if (_innerCmd.startsWith("read_file:")) {
                const _filePath = _innerCmd.substring("read_file:".length).trim();
                if (_filePath) {
                  const _delIndices = [];
                  for (let i = 0; i < _chatLog.length; i++) {
                    const e = _chatLog[i];
                    if (isIdeToolResultMsg(e) && e.content.includes(_filePath)) {
                      _delIndices.push(i);
                    }
                  }
                  _cleanedCount += await _applyClean(_delIndices, _isPurge, `read_file:${path.basename(_filePath)}`);
                  ideClient.removeFromReadCache(_filePath, _qcid);
                }
              } else if (_innerCmd.startsWith("msg:")) {
                // 按消息序号删除: msg:5 或 msg:5,8,12 或 msg:5-12
                // AI 只看到过滤 _hidden 后的上下文（requestBuilder:97 + proxy 两层），故 msg:N 的 N 是
                // 「AI 可见序」。GetChatLog 现返回含隐藏的全序，须经 visibleMap 把可见序翻译为原始下标，
                // 否则有隐藏消息夹在前面时会删/隐藏到错误的消息。
                const { isActiveEntry: _isActive } = await import("../../hide/chatEntryUtils.mjs"); // T8·回切：改指 yonban 新位实现体
                const _visMap = [];
                for (let _vi = 0; _vi < _chatLog.length; _vi++) {
                  if (_isActive(_chatLog[_vi])) _visMap.push(_vi);
                }
                const _msgSpec = _innerCmd.substring("msg:".length).trim();
                const _visIndices = new Set();
                for (const _part of _msgSpec.split(",")) {
                  const _range = _part.trim().match(/^(\d+)\s*-\s*(\d+)$/);
                  if (_range) {
                    for (let _ri = parseInt(_range[1]); _ri <= parseInt(_range[2]); _ri++) _visIndices.add(_ri);
                  } else {
                    const _n = parseInt(_part.trim());
                    if (!isNaN(_n)) _visIndices.add(_n);
                  }
                }
                // msg:N 为 1-based AI 可见序（对齐提示词 msg:1-N 文案；2026-06-22 修 off-by-one：原 _visMap[_v] 0-based，致首条永不清/AI 1-based 数偏一条）→ 转 0-based 查 _visMap
                const _rejected = [];
                const _sorted = [..._visIndices]
                  .map(_v => ({ _v, _raw: _visMap[_v - 1] }))
                  .filter(o => { const ok = o._raw != null && o._raw >= 0 && o._raw < _chatLog.length; if (!ok) _rejected.push(o._v); return ok; })
                  .map(o => o._raw)
                  .sort((a, b) => a - b);
                if (_rejected.length) diag.warn(`[contextClean] msg 越界忽略(有效 1..${_visMap.length}): ${_rejected.join(",")}`);
                _cleanedCount += await _applyClean(_sorted, _isPurge, "msg");
              } else if (_innerCmd.startsWith("code_output:")) {
                // 清理AI消息中的<ideToolCall>/<file_op>标签
                for (let i = 0; i < _chatLog.length; i++) {
                  const e = _chatLog[i];
                  if (e.role !== "user" && e.role !== "system" && e.content && e.content.includes("<ideToolCall")) {
                    const _orig = e.content;
                    let _new = _orig.replace(_ideTagRe, (_, t) => `[已执行: ${t}]`);
                    _new = _new.replace(_fileOpRe, (_, t) => `[已执行: ${t}]`);
                    if (_new.length < _orig.length) {
                      const _messageId = typeof e.id === "string" ? e.id.trim() : "";
                      if (!_messageId) {
                        diag.warn(`contextClean code_output: 消息 indexHint=${i} 缺少稳定 ID，已拒绝按 index 编辑`);
                        opLog("contextClean", "code_output_edit_rejected", { indexHint: i, code: "E_EDIT_MESSAGE_ID_REQUIRED" }, "error");
                        continue;
                      }
                      const _editResult = await _chatOps.editMessage(
                        _chatId,
                        _messageId,
                        i,
                        { content: _new },
                        { expectedUsername: username },
                      );
                      if (_editResult?.applied !== true) {
                        diag.warn(`contextClean code_output: messageId=${_messageId} 未确认编辑 (${_editResult?.reason || _editResult?.error || "unknown"})`);
                        opLog("contextClean", "code_output_edit_not_applied", {
                          indexHint: i,
                          messageId: _messageId,
                          code: _editResult?.code || "E_EDIT_NOT_APPLIED",
                          reason: _editResult?.reason || null,
                        }, "error");
                        continue;
                      }
                      _cleanedCount += 1;
                    }
                  }
                }
              }
            }
            opLog("contextClean", `${_cleanedCount}/${_cleanActions.length}`, { actions: _cleanActions }, _cleanedCount > 0 ? "ok" : "skip");
          } else {
            diag.warn(`contextClean: chatLog不可用 (chatId=${_chatId}), 回退写marks文件`);
            // 回退：写marks文件让getPromptHandler处理（副本，只一轮有效）
            const _cleanDir = ensureMemoryDir(username, charName);
            const _cleanPath = path.join(_cleanDir, "hot", "_context_clean_marks.json");
            let _existingMarks = loadJsonFileIfExists(_cleanPath);
            if (!Array.isArray(_existingMarks)) _existingMarks = [];
            for (const _cmd of _cleanActions) {
              _existingMarks.push({ command: _cmd, markedAt: new Date().toISOString() });
            }
            if (_existingMarks.length > 50) _existingMarks = _existingMarks.slice(-50);
            saveJsonFile(_cleanPath, _existingMarks);
            // T07修复：回退路径也需要清缓存，否则下轮GetPrompt读到旧数据（按本对话分区清）
            if (ideClient && typeof ideClient.clearReadCache === "function") {
              ideClient.clearReadCache(_qcid);
            }
          }
        } catch (_e) {
          wbD(_cid, "memory", "handleReply:contextClean", false, _e.message, { actions: _cleanActions.length });
          diag.error(`contextClean 执行失败: ${_e.message}`);
        }
      } // close else (token threshold allowed)
      } // close if (_cleanActions.length > 0)
      content = content.replace(/<contextClean>[\s\S]*?<\/contextClean>/gi, "");
    }

    // 12b. <fileDelivery> — AI发送文件给用户 (T18新增)
    {
      const _fileDeliveryMatch = content.match(/<fileDelivery\s+path="([^"]+)"(?:\s+name="([^"]*)")?>([\s\S]*?)<\/fileDelivery>/i);
      if (_fileDeliveryMatch && _admit("fileDelivery", "")) {
        const _fdPath = _fileDeliveryMatch[1];
        const _fdName = _fileDeliveryMatch[2] || path.basename(_fdPath);
        const _fdDesc = (_fileDeliveryMatch[3] || "").trim();
        reply.extension._fileDelivery = { path: _fdPath, name: _fdName, description: _fdDesc };
        diag.log(`fileDelivery: ${_fdName} → ${_fdPath}`);
        opLog("fileDelivery", _fdName, { path: _fdPath }, "ok");
      }
      content = content.replace(/<fileDelivery[\s\S]*?<\/fileDelivery>/gi, "");
    }

    // 13. <分身N> — 正式分身批次只通过生命周期协调器运行。
    {
      try {
        const _cloneBatch = await coordinateCloneBatch({
          tasks: _preExtracted.cloneTasks || [],
          username,
          charName,
          chatId: _cid,
          queueChatId: _qcid,
          chatLog: args?.chat_log || [],
          charDisplayName: args?.char_name || "",
          generationArgs: args,
          admit: _admit,
          createBatchId: _delegId,
          runWithConcurrency: _runWithConcurrency,
          opLog,
        });
        if (_cloneBatch.duplicateSuppressed?.length > 0) {
          reply.extension._cloneDuplicateSuppressed = _cloneBatch.duplicateSuppressed;
        }
        if (_cloneBatch.contentAppend) content += _cloneBatch.contentAppend;
        if (_cloneBatch.stopContinue) reply.extension._stopContinue = true;
        if (_cloneBatch.aggregate) reply.extension._cloneAggregate = _cloneBatch.aggregate;
        if (_cloneBatch.results) reply.extension._cloneResults = _cloneBatch.results;
      } catch (error) {
        wbD(_cid, "memory", "handleReply:cloneSystem", false, error.message, {});
        diag.error(`分身系统执行失败: ${error.message}\n${error.stack || ""}`);
        ideClient.enqueuePendingResult({
          tool: "_clone_results",
          params: {},
          result: { success: false, error: `分身系统执行失败: ${error.message}` },
          chatid: _qcid,
          ownerUsername: username,
          timestamp: new Date().toISOString(),
        });
      }
      content = content.replace(/<分身\d+[^>]*>[\s\S]*?<\/分身\d+>/gi, "");
    }


    // 14a. <presetSwitch> 已废弃，统一使用 <subModeSwitch>，仅清理标签
    content = content.replace(/<presetSwitch>[\s\S]*?<\/presetSwitch>/gi, "");

    // 14b. <stopContinue/> — AI主动停止自动继续（使用预提取数据，排除反引号内引用）
    // 【红线·0731】此标签语义=任务域"本轮任务做完了"，只产 extension._stopContinue 运行态信号
    //   （消费端 generation.mjs stopContinue 分支：结束当前任务轮）。禁止由它触发任何持久配置写
    //   （yonban_config.auto_continue）或前端配置开关翻转——「操作后自动继续」系统开关只归用户。
    const _scContent14b = content.replace(/`[^`]*`/g, "").replace(/```[\s\S]*?```/g, "");
    if (_preExtracted.stopContinue || /<stopContinue\s*\/?>/.test(_scContent14b)) {
      reply.extension._stopContinue = true;
      content = content.replace(/<stopContinue\s*\/?>/gi, "");
    }

    // 14c. <scheduleWakeup delay="N" reason="..."/> — AI请求定时唤醒（属性顺序不限）
    const _swTag = content.match(/<scheduleWakeup\s([^>]*?)\/?>/i);
    const _swDelayMatch = _swTag?.[1]?.match(/delay="(\d+)"/);
    const _swReasonMatch = _swTag?.[1]?.match(/reason="([^"]*)"/);
    if (_swDelayMatch && !_admit("scheduleWakeup", `delay=${_swDelayMatch[1]}`)) {
      // [P0-B] 拒绝三件套已由 _admit 记账；标签由下方 replace 照剥
    } else if (_swDelayMatch) {
      const _swDelay = Math.max(5, Math.min(3600, parseInt(_swDelayMatch[1])));
      const _swReason = _swReasonMatch?.[1] || "";
      reply.extension._scheduleWakeup = { delay: _swDelay, reason: _swReason };
      reply.extension._stopContinue = true;
      opLog("scheduleWakeup", `delay=${_swDelay}`, { reason: _swReason });
      setTimeout(async () => {
        try {
          const { dispatchActivation } = await import("../../../../../public/parts/plugins/beilu-memory/lib/tools/dispatchActivation.mjs");
          await dispatchActivation({ source: "ai", action: { type: "auto_reply" }, chatid: _cid, charname: charName });
        } catch (e) { console.warn("[replyHandler] scheduleWakeup backend dispatch:", e?.message); }
      }, _swDelay * 1000);
      content = content.replace(/<scheduleWakeup\s[^>]*?\/?>/gi, "");
    }

    // 14d. <wakeWindow chatid="..." reason="..."/> — A-1：AI 立即跨窗口唤醒另一会话。
    // 与 14c scheduleWakeup（自窗口定时）区分：此为跨窗口 + 立即触发，经统一入口 dispatchActivation wake（后端已通）。
    // 凛倾简化唤醒：一命令发一次，不做 corrId 轮询。同方向30s防循环（与sendToWindow同模式）。
    const _wwTag = content.match(/<wakeWindow\s([^>]*?)\/?>/i);
    if (_wwTag && !_admit("wakeWindow", `→${_wwTag[1].match(/chatid="([^"]+)"/)?.[1] || ""}`)) {
      // [P0-B] 拒绝三件套已由 _admit 记账；标签由下方 replace 照剥
    } else if (_wwTag) {
      const _wwChatid = _wwTag[1].match(/chatid="([^"]+)"/)?.[1] || "";
      const _wwReason = _wwTag[1].match(/reason="([^"]*)"/)?.[1] || "";
      if (_wwChatid) {
        // 防循环：同方向30s内重复wakeWindow跳过（防A→B→A死循环，与sendToWindow同模式）
        const _wwPairKey = `${_cid}→${_wwChatid}`;
        const _wwNow = Date.now();
        const _wwLast = _wwRecent.get(_wwPairKey) || 0;
        if (_wwNow - _wwLast < 30000) { opLog("wakeWindow", `→${_wwChatid}`, { skipped: "30s内重复唤醒,防循环" }, "skip"); }
        else {
        _wwRecent.set(_wwPairKey, _wwNow);
        for (const [k, v] of _wwRecent) { if (_wwNow - v > 60000) _wwRecent.delete(k); }
        import("../../../../../public/parts/plugins/beilu-memory/lib/tools/dispatchActivation.mjs")
          .then(({ dispatchActivation }) => dispatchActivation({
            source: "ai",
            // 不传 charname：跨窗口唤醒时目标窗口用自己的角色（triggerCharReply 无 charname 自取目标 chat 第一个角色）；
            // 传发起方 charName 会让异角色目标窗口 throw "char not found" 被 .catch 吞掉 → 静默失败。
            action: { type: "wake", target: { chatid: _wwChatid } },
          }))
          .catch((e) => { wbD(_cid, "memory", "handleReply:wakeWindow:dispatch", false, e.message, { target: _wwChatid }); console.warn(`[beilu-memory] wakeWindow dispatchActivation 失败: ${e.message}`); });
        opLog("wakeWindow", `→${_wwChatid}`, { reason: _wwReason }, "ok");
        }
      }
      content = content.replace(/<wakeWindow\s[^>]*?\/?>/gi, "");
    }

    // 14e. <sendToWindow chatid="..." [name="自报窗口名"]>内容</sendToWindow> — 跨窗口传话（凛倾 2026-06-12）：
    // 目标会话插入用户位消息「[来自窗口 X] 内容」+ 触发其生成（dispatchActivation type:"message"）。
    // 与 14d wakeWindow（只唤醒不带话）区分。C-4 防循环：同一方向 30s 内重复投递跳过（防 A→B→A 死循环）。
    const _stwTags = [...content.matchAll(/<sendToWindow\s([^>]*?)>([\s\S]*?)<\/sendToWindow>/gi)];
    if (_stwTags.length > 0 && !_admit("sendToWindow", `×${_stwTags.length}`)) {
      // [P0-B] 拒绝三件套已由 _admit 记账；标签由下方 replace 照剥
    } else {
      for (const _stw of _stwTags) {
        const _stwChatid = _stw[1].match(/chatid="([^"]+)"/)?.[1] || "";
        const _stwBody = (_stw[2] || "").trim();
        if (!_stwChatid || !_stwBody) continue;
        const _stwPairKey = `${_cid}→${_stwChatid}`;
        const _stwNow = Date.now();
        const _stwLast = _stwRecent.get(_stwPairKey) || 0;
        if (_stwNow - _stwLast < 30000) { opLog("sendToWindow", `→${_stwChatid}`, { skipped: "30s内重复投递,防循环" }, "skip"); continue; }
        _stwRecent.set(_stwPairKey, _stwNow);
        for (const [k, v] of _stwRecent) { if (_stwNow - v > 60000) _stwRecent.delete(k); }
        const _stwFrom = _stw[1].match(/name="([^"]*)"/)?.[1]
          || `${charName || "?"}:${String(_cid || "").slice(0, 8)}`;
        import("../../../../../public/parts/plugins/beilu-memory/lib/tools/dispatchActivation.mjs")
          .then(({ dispatchActivation }) => dispatchActivation({
            source: "ai",
            action: { type: "message", target: { chatid: _stwChatid }, content: `[来自窗口 ${_stwFrom}] ${_stwBody}` },
          }))
          .then((r) => { if (!r?.dispatched) { wbD(_cid, "memory", "handleReply:sendToWindow:undelivered", false, `未送达 →${_stwChatid}: ${r?.reason}`, { target: _stwChatid, reason: r?.reason }); console.warn(`[beilu-memory] sendToWindow 未送达 →${_stwChatid}: ${r?.reason}`); } })
          .catch((e) => { wbD(_cid, "memory", "handleReply:sendToWindow:dispatch", false, e.message, { target: _stwChatid }); console.warn(`[beilu-memory] sendToWindow dispatchActivation 失败: ${e.message}`); });
        opLog("sendToWindow", `→${_stwChatid}`, { from: _stwFrom, length: _stwBody.length }, "ok");
      }
    }
    if (_stwTags.length) {
      content = content.replace(/<sendToWindow\s[^>]*?>[\s\S]*?<\/sendToWindow>/gi, "");
    }

    // [P0-A 2026-08-03] 显示剥离 + W24 输出管控收口单源 _composeContentForShow（定义见 XML 容错段后），
    // 与提案硬门提前收尾共用同一实现，行为与原内联代码等价。
    await _composeContentForShow();

    reply._memory_tags_processed = true;

    // 自动检查归档（含聊天P2 + 编程P2-code）
    // T1：归档链已 await 化——此处从 fire-and-forget 改 await，归档落盘失败沿 handleReply 既有 topCatch 路径
    //   捕获记录（不再静默丢归档）。onTriggerP2 系列回调内部仍各自 .catch 异步触发，不受此 await 阻塞。
    await autoCheckArchiveTriggers(username, charName, {
      onTriggerP2: async (u, c, ctx) => {
        const { triggerP2Summary } = await import("../ai/aiRunner.mjs");
        return triggerP2Summary(u, c, ctx);
      },
      onTriggerP2Code: async (u, c, ctx) => {
        const { triggerP2CodeArchive } = await import("../ai/aiRunner.mjs");
        return triggerP2CodeArchive(u, c, ctx);
      },
    }, { chatLog: args?.chat_log, chatId: _cid });

    // ★ 编程模式表格定期清理（每N轮触发，用配置的清理频率）
    // T1 修复：轮次计数器改存模块级 _tableCleanRounds Map（key=username/charName/chatId），跨轮累积。
    //   原病：_cleanRound 读自 reply.extension（每轮新建的临时对象），恒 0 且写回后随 reply 生命周期丢失 →
    //   _cleanRound > 0 永假 → 表格清理提醒永远不触发。现按会话 key 持久化于进程内 Map，跨轮递增正确。
    const _activeMode = resolveGenerationMode(args, username, charName, _cid);
    if (_activeMode === "code" || _activeMode === "work") {
      try {
        const _cleanConfig = loadJsonFileIfExists(
          getYonbanConfigPath(username), {}
        );
        const _cleanFreq = _cleanConfig.tableCleanFrequency || 0; // 0=不自动清理
        if (_cleanFreq > 0) {
          const _cleanKey = `${username}/${charName}/${_cid || "_"}`;
          const _cleanRound = _tableCleanRounds.get(_cleanKey) || 0;
          if (_cleanRound > 0 && _cleanRound % _cleanFreq === 0) {
            // ⚠ FIX: 不能用 data 变量 — 它只在 tableEdit 执行分支内声明，此处需独立加载
            const _cleanData = loadMemoryData(username, charName, undefined, _cid);
            const _totalRows = _cleanData.tables.reduce((s, t) => s + (t.rows?.length || 0), 0);
            if (_totalRows > 30) {
              diag.log(`表格清理触发: 第${_cleanRound}轮, 共${_totalRows}行`);
              // 注入提醒让主AI知道该清理了
              ideClient.enqueuePendingResult({
                tool: "_table_clean_reminder",
                params: {},
                result: { success: true, result: `[表格清理提醒] 当前表格共${_totalRows}行，建议执行清理。可以使用<tableEdit>标签删除已完成任务、过时条目、重复内容。` },
                chatid: _qcid,
                timestamp: new Date().toISOString(),
              });
            }
          }
          _tableCleanRounds.set(_cleanKey, _cleanRound + 1);
        }
      } catch (_tcErr) { wbD(_cid, "memory", "handleReply:tableCleanReminder", false, _tcErr.message, {}); }
    }

    // W61: auto_advance — 如果流程组正在执行且auto_advance=true，自动推进到下一步
    try {
      const _aaMemDir = ensureMemoryDir(username, charName);
      const _aaConfigPath = getWorkConfigPath(username, charName); // T7 尾段收口：权威路径单点
      if (fs.existsSync(_aaConfigPath)) {
        // [0722 锁收口] load→推进→save 整段走 updateWorkConfig 串行锁——原 load 与 save(段尾) 之间
        //   隔多个 await（组文件读/嵌套 updateYonbanConfig/预设应用/AIsource SetData）=最宽竞态窗，
        //   与动作五 case/scheduler 快照写并发即 lost-update。嵌套锁序恒 work外→yonban内（全局不变式，
        //   见 storage.updateWorkConfig 注释）。非 running/组文件缺失 SKIP_SAVE=原「不进推进块不写」语义。
        await updateWorkConfig(username, charName, async (_aaConfig) => {
        // D09 收口：槽解析单源（原手抄迁移块+回退取槽收敛 storage.resolveWorkflowSlot，语义不变=per-chatid 优先 _default 兜底）
        const { slot: _aaSlot } = resolveWorkflowSlot(_aaConfig, _cid);
        if (_aaSlot?.active_workflow && _aaSlot.workflow_state?.status === "running") {
          const _aaWfPath = path.join(_aaMemDir, "work", "workflows", _aaSlot.active_workflow);
          if (fs.existsSync(_aaWfPath)) {
            const _aaWf = JSON.parse(await fs.promises.readFile(_aaWfPath, "utf-8"));
            // completionVerify 闸门：本轮回复明显失败（错误/空）时不推进——步骤没真完成不该自动前进（reality-gate，向后兼容：正常完成照常推进）。
            const _aaReplyText = (reply?.content || reply?.content_for_show || "").trim();
            const _aaStepFailed = _aaReplyText.length === 0 || _aaReplyText.startsWith("⚠️") || _aaReplyText.includes("生成失败");
            // B6 反虚报硬闸：flow_completion_gate 开（默认 true）时，推进还要求本轮回复含非空 <completionVerify> 标签（步骤自证完成）。
            //   预设需配套教学 AI 在完成时输出 <completionVerify>…</completionVerify>（提示词侧归凛倾，此处只建机制闸门）。
            //   false=旧行为：仅查非空非错误即可推进，用户可在流程组 json 关闭。
            const _aaGateOn = _aaWf.flow_completion_gate !== false; // 缺省视为开
            const _aaCvMatch = _aaReplyText.match(/<completionVerify>([\s\S]*?)<\/completionVerify>/i);
            const _aaVerified = !!(_aaCvMatch && _aaCvMatch[1] && _aaCvMatch[1].trim().length > 0);
            if (_aaWf.auto_advance && _aaStepFailed) {
              wbT(_cid, "memory", "handleReply:autoAdvance:skip_failed_step", { reason: _aaReplyText.length === 0 ? "empty" : "error" });
            } else if (_aaWf.auto_advance && _aaGateOn && !_aaVerified) {
              // 步骤未自证完成：停在当前步，通过现成跨模式通知通道告知用户待确认（不 current_step++）。
              wbT(_cid, "memory", "handleReply:autoAdvance:gate_unverified", { step: _aaSlot.workflow_state?.current_step });
              reply.extension = reply.extension || {};
              reply.extension._crossModeNotification = {
                title: "步骤未验证完成",
                message: `流程「${_aaSlot.active_workflow.replace(/\.json$/i, "")}」当前步骤未输出 <completionVerify> 验证，已停留待确认（不自动推进）。`,
                targetTab: "work",
                level: "warning",
              };
              opLog("autoAdvance", "gate_unverified", { workflow: _aaSlot.active_workflow }, "ok");
            } else if (_aaWf.auto_advance) {
              const _aaState = _aaSlot.workflow_state;
              // 记录当前步骤完成
              _aaState.step_history.push({
                step: _aaState.current_step,
                label: _aaWf.steps[_aaState.current_step]?.label || `步骤${_aaState.current_step}`,
                completed_at: new Date().toISOString(),
                result: "auto_advance",
              });
              _aaState.current_step++;
              if (_aaState.current_step >= _aaState.total_steps) {
                _aaState.status = "completed";
                _aaState.completed_at = new Date().toISOString();
                _aaSlot.active_workflow = "";
              } else {
                const nextStep = _aaWf.steps[_aaState.current_step];
                const needsApproval = Array.isArray(_aaWf.approval_before) && _aaWf.approval_before.includes(nextStep?.label || nextStep?.mode);
                if (needsApproval) {
                  _aaState.status = "awaiting_approval";
                } else {
                  // 自动切预设/模式
                  if (nextStep?.mode) {
                    // D3 0804 三入口收口：map 写 + activation 记录 + 默认预设应用（0708 生效模型）+ 事件体
                    //   统一走 activateSubModeCore（source="auto_advance"）。嵌套锁序不变=work外→yonban内
                    //   （core 内 updateYonbanConfig 与原内联同位）。行为差异（root修）：
                    //   ① 未知子模式 id 由 core fail-closed 拒绝，不再写悬空 active id（原 find 落空仍
                    //      writeActiveSubModeId=悬空引用）；拒绝 wbD 可见留痕，流程推进本身不回滚。
                    //   ② 事件 from=map 实际前值（core 单源）非流程步声明 mode——实际状态优于声明。
                    //   ③ 原 nextStep 仅 preset_name 无 mode 时发 to:"" 空事件已删（无语义消费者，T046 后
                    //      preset 不再由此块处理）。
                    reply.extension = reply.extension || {};
                    const _aaAct = await activateSubModeCore({ username, charName, chatId: _cid, subModeId: nextStep.mode, source: "auto_advance" });
                    if (_aaAct?.success) {
                      const _aaTargetSm = _aaAct.subMode;
                      reply.extension._subModeSwitch = _aaAct.event;
                      // T046：不再下发 _subModeSwitchPreset（前端强制切预设=死绑）——后端生成时按子模式绑定隔离。
                      if (_aaTargetSm?.model_params) {
                        reply.extension._subModeSwitchModelParams = _aaTargetSm.model_params;
                      }
                      // [0804 根因修·RC11断点7] 同 <subModeSwitch> 路径：零角色全局 AIsource 写，
                      //   流程推进的源覆盖走既有 per-request 链（active submode 已落盘→下轮生成局部生效）。
                      if (_aaTargetSm?.apiSource) {
                        reply.extension._subModeSwitchApiSource = _aaTargetSm.apiSource;
                      }
                    } else {
                      wbD(_cid, "memory", "handleReply:autoAdvance:activate", false, `${_aaAct?.code || ""} ${_aaAct?.error || ""}`, { to: nextStep.mode });
                      console.warn(`[beilu-memory] auto_advance 子模式激活被拒: ${nextStep.mode} — ${_aaAct?.error || _aaAct?.code || "未知错误"}`);
                    }
                  }
                }
              }
              return _aaConfig; // [0722 锁收口] 原 saveJsonFile 位置：仅成功推进分支落盘
            }
          }
        }
        return SKIP_SAVE; // skip_failed/gate_unverified/非 running/组文件缺失：原不写盘语义
        }, {});
      }
    } catch (_aaErr) {
      wbD(_cid, "memory", "handleReply:autoAdvance", false, _aaErr.message, {});
      console.warn("[beilu-memory] auto_advance检查失败:", _aaErr.message);
    }
  } catch (e) {
    wbD(_cid, "memory", "handleReply:topCatch", false, e.message, { stack: (e.stack || "").substring(0, 300) });
    console.error("[beilu-memory] ReplyHandler error:", e.message);
    opLog("error", "handleReply crashed", { error: e.message, stack: (e.stack || "").substring(0, 200) }, "fail");
    const errorBase = reply.content_for_show || reply.content;
    reply.content_for_show = _stripAllTags(errorBase);
    wbT(_cid, "memory", "handleReply:topCatchStrip", { before: (errorBase || "").length, after: (reply.content_for_show || "").length });
  }

  wbT(_cid, "memory", "handleReply:exit", {});
  return false;
}

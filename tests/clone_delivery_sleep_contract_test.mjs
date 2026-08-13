import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const generationSource = fs.readFileSync(path.join(root, "src/public/parts/shells/beilu-chat/src/lib/generation.mjs"), "utf8");
const coordinatorSource = fs.readFileSync(path.join(root, "src/yonban/core/functions/memory/ai/cloneBatchCoordinator.mjs"), "utf8");
const cardSource = fs.readFileSync(path.join(root, "src/public/parts/shells/beilu-chat/public/src/panels/task/cloneProgressCard.mjs"), "utf8");

// 停止闸必须早于 generating/timer 分支，且不得进入唤醒队列。
const notifyStart = generationSource.indexOf("export function notifyResultReady");
const notifyEnd = generationSource.indexOf("export function notifyAsyncCloneDone", notifyStart);
const notifyBody = generationSource.slice(notifyStart, notifyEnd);
assert.ok(notifyBody.indexOf('_userStoppedChats.has(chatid)') < notifyBody.indexOf('_generatingChats.has(chatid)'), "user stop must gate before generating queue");
assert.match(notifyBody, /reason: "user_stopped"/);
assert.match(notifyBody, /reason: "already_consumed"/);
assert.match(generationSource, /suppressed_user_stop_at_fire/);

// 同一完成收尾：持久化读回 -> pendingResults -> 唯一 notifyResultReady -> 信息投影。
const finishStart = coordinatorSource.indexOf("const finish =");
const finishEnd = coordinatorSource.indexOf("\n  if (asyncMode) {", finishStart);
const finishBody = coordinatorSource.slice(finishStart, finishEnd);
const saveAt = finishBody.indexOf("saveCloneResult(");
const enqueueAt = finishBody.indexOf("ideClient.enqueuePendingResult(");
const notifyAt = finishBody.indexOf("notifyAsyncCloneDone");
const broadcastAt = finishBody.indexOf('type: "tool_results_ready"');
assert.ok(saveAt >= 0 && enqueueAt > saveAt && notifyAt > enqueueAt && broadcastAt > notifyAt, "finish order must be persist -> enqueue -> notify -> project");
assert.match(finishBody, /if \(finishPromise\) return finishPromise/);
assert.match(finishBody, /background: asyncMode/);

// Web 只消费真实 detached 就绪事件，用 resultId 幂等，不触发生成。
assert.match(cardSource, /beilu:toolResultsReady/);
assert.match(cardSource, /d\.background !== true/);
assert.match(cardSource, /_readyResults\.set\(String\(d\.resultId\)/);
assert.doesNotMatch(cardSource, /triggerCharReply|scheduleAutoContinue/);

// 真队列行为：下次互动所用的既有 consume 口对定向结果只交付一次。
const { ideClient } = await import("../src/yonban/core/transport/ideClient.mjs");
const nonce = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const chatid = `fix06-chat-${nonce}`;
const ownerUsername = `fix06-owner-${nonce}`;
const resultId = `clone-result:${nonce}`;
assert.equal(ideClient.registerChatOwner(chatid, ownerUsername), true);
assert.equal(ideClient.enqueuePendingResult({
  tool: "_clone_results",
  params: { resultId, cloneBatchId: `batch-${nonce}`, charName: "_global" },
  result: { success: true, result: "ok" },
  chatid,
  ownerUsername,
  timestamp: new Date().toISOString(),
}), true);
assert.equal(ideClient.getPendingResultCount({ ownerUsername, chatid }), 1);
assert.equal(ideClient.consumePendingResults(chatid, ownerUsername).length, 1);
assert.equal(ideClient.consumePendingResults(chatid, ownerUsername).length, 0);
assert.equal(ideClient.getPendingResultCount({ ownerUsername, chatid }), 0);

console.log("clone delivery sleep contract test passed: stop=0 wake, finish order fixed, queue consumption exactly once");

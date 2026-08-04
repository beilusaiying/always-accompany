/**
 * startup_readiness_contract_test.mjs — 启动 Readiness 契约（D5 §2.4）：
 * ping 与 readiness 分离（阶段机单源）/ 阶段只前进 / degraded 不倒退 / 最小快照不泄露明细 /
 * 无 stored config 不 SetData({})（parts_loader.resolvePartConfigLoadPlan 首启约束）。
 * 真实冷启动时序（浏览器打开时机/黑屏消除）属静态不可判定点：未验证，归 E2E（未运行）。
 */
import assert from "node:assert/strict";

import {
  getReadinessSnapshot,
  getReadinessSnapshotMinimal,
  markReadinessStage,
  reportPartPreloadState,
  setBackgroundPreloadState,
  setChatInteractiveProbe,
} from "../src/server/readiness.mjs";

Deno.test("阶段机：按序前进、不倒退、未知阶段拒绝；shellReady 只在 SHELL_READY 起为真", () => {
  const s0 = getReadinessSnapshot();
  assert.equal(s0.stage, "PROCESS_START");
  assert.equal(s0.shellReady, false);
  assert.equal(markReadinessStage("NOT_A_STAGE"), false);
  assert.equal(markReadinessStage("LISTENING"), true);
  assert.equal(getReadinessSnapshot().shellReady, false, "LISTENING(=ping 可答) 不得冒充 shellReady");
  assert.equal(markReadinessStage("SHELL_READY"), true);
  assert.equal(getReadinessSnapshot().shellReady, true);
  assert.equal(markReadinessStage("LISTENING"), false, "阶段不得倒退");
  assert.equal(markReadinessStage("BACKGROUND_PRELOAD"), true);
  assert.equal(getReadinessSnapshot().shellReady, true, "后台预加载不倒退 shellReady");
  const stages = getReadinessSnapshot().stages.map((s) => s.stage);
  assert.deepEqual(stages, ["PROCESS_START", "LISTENING", "SHELL_READY", "BACKGROUND_PRELOAD"]);
});

Deno.test("后台预加载可观察：逐 Part 状态/degraded 明细；failed 不被 loading 洗白，真实 loaded 才恢复", () => {
  setBackgroundPreloadState("running");
  reportPartPreloadState("u1", "plugins/a", "loading");
  reportPartPreloadState("u1", "plugins/a", "loaded");
  reportPartPreloadState("u1", "plugins/b", "loading");
  reportPartPreloadState("u1", "plugins/b", "failed", "boom");
  // failed 后又被标 loading（重试中）：degraded 记录不得先行消失
  reportPartPreloadState("u1", "plugins/b", "loading");
  let snap = getReadinessSnapshot();
  assert.equal(snap.backgroundPreload.counts.loaded, 1);
  assert.equal(snap.backgroundPreload.degraded.length, 1);
  assert.equal(snap.backgroundPreload.degraded[0].partpath, "plugins/b");
  assert.match(snap.backgroundPreload.degraded[0].error, /boom/);
  // 真实加载成功才摘掉 degraded
  reportPartPreloadState("u1", "plugins/b", "loaded");
  snap = getReadinessSnapshot();
  assert.equal(snap.backgroundPreload.degraded.length, 0);
  setBackgroundPreloadState("done");
  assert.equal(getReadinessSnapshot().backgroundPreload.state, "done");
});

Deno.test("per-user chatInteractive 经探针计算；未认证最小快照不含 Part 明细/用户维度", () => {
  setChatInteractiveProbe((username) => username === "ready-user");
  assert.equal(getReadinessSnapshot("ready-user").chatInteractive, true);
  assert.equal(getReadinessSnapshot("cold-user").chatInteractive, false);
  assert.equal(getReadinessSnapshot().chatInteractive, null);
  const minimal = getReadinessSnapshotMinimal();
  assert.deepEqual(Object.keys(minimal).sort(), ["shellReady", "stage", "uptimeMs"]);
});

Deno.test("首启约束：无 stored config 时 legacy 默认策略不 SetData({})；显式声明契约才保留空对象初始化", async () => {
  const { resolvePartConfigLoadPlan, resolvePartConfigContractLoadPlan } = await import("../src/server/parts_loader.mjs");
  // legacy 默认(未声明 loadPolicy)：首启无 stored config → 跳过（「第二次才生效」风险源根除）
  const legacyFirstBoot = resolvePartConfigLoadPlan(undefined, false, undefined, "plugins/x");
  assert.equal(legacyFirstBoot.shouldApply, false);
  assert.equal(legacyFirstBoot.firstBootSkipped, true);
  // legacy 默认 + 有 stored config → 照常应用
  const legacyStored = resolvePartConfigLoadPlan(undefined, true, { k: 1 }, "plugins/x");
  assert.equal(legacyStored.shouldApply, true);
  assert.deepEqual(legacyStored.data, { k: 1 });
  // 显式 loadPolicy:'always' = 空对象初始化安全声明 → 首启仍收 {}
  const declaredAlways = resolvePartConfigLoadPlan("always", false, undefined, "plugins/y");
  assert.equal(declaredAlways.shouldApply, true);
  assert.deepEqual(declaredAlways.data, {});
  // configContract:'state' 经映射同为显式声明 → 首启仍收 {}
  const contractState = resolvePartConfigContractLoadPlan("state", undefined, false, undefined, "plugins/z");
  assert.equal(contractState.shouldApply, true);
  assert.deepEqual(contractState.data, {});
  // stored-only 语义不变
  const storedOnly = resolvePartConfigLoadPlan("stored-only", false, undefined, "plugins/w");
  assert.equal(storedOnly.shouldApply, false);
});

/**
 * pet_lifecycle_contract_test.mjs — PetLifecycle 契约（D5 §2.1）：
 * effectiveDesired 四象限 / lease 生命周期 / 显式关闭接管 / 停止 10s ack 判定 / spawn 心跳确认。
 *
 * 只 import interaction_lease.mjs 叶子（零依赖）——绝不 import screenshot/main.mjs
 * （其 import 副作用含 autostart 定时器与真实 Electron spawn，测试环境禁触）。
 * 进程编排（真实 spawn/kill/心跳）属静态不可判定点：未验证，归 E2E（readiness_pet_stt.e2e.mjs，未运行）。
 */
import assert from "node:assert/strict";

import {
  acquireInteractionLease,
  computeEffectiveDesired,
  hasActiveInteractionLease,
  listInteractionLeases,
  onInteractionLeaseChange,
  releaseInteractionLease,
  resolveHeartbeatConfirm,
  resolveStopOutcome,
  revokeInteractionLeases,
  STOP_ACK_DEADLINE_MS,
} from "../src/yonban/core/functions/screenshot/interaction_lease.mjs";

function resetLeases() {
  revokeInteractionLeases("test-reset");
}

Deno.test("effectiveDesired 四象限：explicit || lease，停止互动只撤 lease", () => {
  resetLeases();
  // 原关 × 无互动
  assert.equal(computeEffectiveDesired(false, hasActiveInteractionLease()), false);
  // 原关 × 开始互动 → 临时开启
  const lease = acquireInteractionLease("u1", "chat-a");
  assert.equal(computeEffectiveDesired(false, hasActiveInteractionLease()), true);
  // 原开 × 停止互动 → 显式开启的桌宠仍在（不误关）
  releaseInteractionLease(lease);
  assert.equal(computeEffectiveDesired(true, hasActiveInteractionLease()), true);
  // 原关 × 停止互动 → 会停
  assert.equal(computeEffectiveDesired(false, hasActiveInteractionLease()), false);
});

Deno.test("lease 不持久化：模块重载（重启语义）后无 lease，不遗留自动启用", async () => {
  resetLeases();
  acquireInteractionLease("u1", "chat-a");
  assert.equal(hasActiveInteractionLease(), true);
  // 重启语义 = 全新模块实例（cache-bust 再 import）：内存租约必然为空
  const fresh = await import("../src/yonban/core/functions/screenshot/interaction_lease.mjs?restart=" + Date.now());
  assert.equal(fresh.hasActiveInteractionLease(), false);
  assert.equal(fresh.computeEffectiveDesired(false, fresh.hasActiveInteractionLease()), false);
  resetLeases();
});

Deno.test("显式关闭=接管：revoke 吊销全部 lease；已吊销的 lease release 幂等返回 false", () => {
  resetLeases();
  const l1 = acquireInteractionLease("u1", "c1");
  const l2 = acquireInteractionLease("u1", "c2");
  assert.equal(listInteractionLeases().length, 2);
  assert.equal(revokeInteractionLeases("explicit-off"), 2);
  assert.equal(hasActiveInteractionLease(), false);
  assert.equal(releaseInteractionLease(l1), false);
  assert.equal(releaseInteractionLease(l2), false);
});

Deno.test("lease 变更广播：acquire/release/revoke 各触发一次，订阅方异常不阻断", () => {
  resetLeases();
  const events = [];
  onInteractionLeaseChange((e) => { events.push(e.type); });
  onInteractionLeaseChange(() => { throw new Error("订阅方炸了也不许阻断"); });
  const l = acquireInteractionLease("u1", "c1");
  releaseInteractionLease(l);
  acquireInteractionLease("u1", "c2");
  revokeInteractionLeases("t");
  assert.deepEqual(events, ["acquire", "release", "acquire", "revoke"]);
});

Deno.test("停止 ack 判定：本代 child 走 exit 落定，到期升级 SIGKILL（不谎报 stopped）", () => {
  // exit 已落定 → confirmed
  assert.equal(resolveStopOutcome({ childExited: true, hasChild: true, heartbeatAgoMs: 0, heartbeatStaleMs: 10000, elapsedMs: 500 }), "confirmed");
  // 未落定未到期 → waiting
  assert.equal(resolveStopOutcome({ childExited: false, hasChild: true, heartbeatAgoMs: 0, heartbeatStaleMs: 10000, elapsedMs: 9999 }), "waiting");
  // 到期未退 → escalate_kill（升级后仍等 status 落定才置 stopped）
  assert.equal(resolveStopOutcome({ childExited: false, hasChild: true, heartbeatAgoMs: 0, heartbeatStaleMs: 10000, elapsedMs: STOP_ACK_DEADLINE_MS }), "escalate_kill");
});

Deno.test("停止 ack 判定：接管实例（无句柄）走心跳消失；到期心跳仍新鲜=stop_timeout 保持 stopping", () => {
  // 心跳已失效 → confirmed
  assert.equal(resolveStopOutcome({ childExited: false, hasChild: false, heartbeatAgoMs: 10001, heartbeatStaleMs: 10000, elapsedMs: 500 }), "confirmed");
  // 从未见过心跳 → 无存活证据 → confirmed
  assert.equal(resolveStopOutcome({ childExited: false, hasChild: false, heartbeatAgoMs: null, heartbeatStaleMs: 10000, elapsedMs: 500 }), "confirmed");
  // 心跳新鲜未到期 → waiting
  assert.equal(resolveStopOutcome({ childExited: false, hasChild: false, heartbeatAgoMs: 2000, heartbeatStaleMs: 10000, elapsedMs: 5000 }), "waiting");
  // 心跳新鲜且到期 → timeout（状态保持 stopping，不得置 stopped）
  assert.equal(resolveStopOutcome({ childExited: false, hasChild: false, heartbeatAgoMs: 2000, heartbeatStaleMs: 10000, elapsedMs: STOP_ACK_DEADLINE_MS }), "timeout");
});

Deno.test("spawn 心跳确认：露面时刻>=spawn 才算本代；10s 无心跳=unconfirmed（不谎报 running）", () => {
  const spawnedAt = 1_000_000;
  // spawn 前的旧心跳不算
  assert.equal(resolveHeartbeatConfirm({ spawnedAt, heartbeatSeenAt: spawnedAt - 1, now: spawnedAt + 500 }), "waiting");
  // 本代心跳到达 → running
  assert.equal(resolveHeartbeatConfirm({ spawnedAt, heartbeatSeenAt: spawnedAt + 100, now: spawnedAt + 500 }), "running");
  // 超窗无心跳 → unconfirmed
  assert.equal(resolveHeartbeatConfirm({ spawnedAt, heartbeatSeenAt: null, now: spawnedAt + STOP_ACK_DEADLINE_MS }), "unconfirmed");
  // 迟到心跳仍可回升 running（error_unconfirmed 不是死终态）
  assert.equal(resolveHeartbeatConfirm({ spawnedAt, heartbeatSeenAt: spawnedAt + 20_000, now: spawnedAt + 21_000 }), "running");
});

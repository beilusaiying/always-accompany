/**
 * auth_identity_memory_browser_contract_test.mjs — D6 §1 认证身份契约（2026-08-04 窗口A）。
 * 覆盖（静态+单元层）：
 *   1. memoryBrowser 源契约：payload 零身份字段（无 username / 无 "_default" 伪身份兜底）+
 *      epoch 守卫已接（在飞结果丢弃点存在）。
 *   2. sessionIdentity 单元：whoami 单源建身份、同 origin 换用户 epoch 换代+事件、
 *      旧 epoch 结果丢弃判定、失效后 fail-closed（不猜身份）。
 * 运行时层（双用户真实浏览器写盘路径验证）不在本测试内——如实标注，方式待定。
 * 后端防线（handleSetData E_IDENTITY_MISMATCH / bridge scope.user 盖章）由
 * files_root_authority_contract_test.mjs 与既有 setDataActions 闸覆盖，此处不重复。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const _repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const _shellSrc = path.join(_repoRoot, "src", "public", "parts", "shells", "beilu-chat", "public", "src");

Deno.test("memoryBrowser source contract: no identity payload, epoch guards wired", () => {
  const raw = fs.readFileSync(path.join(_shellSrc, "panels", "memory", "memoryBrowser.mjs"), "utf-8");
  // 只对【代码】断言：剥掉行注释（注释里合法引用旧病原文，不能触发回归锁）。
  const src = raw.split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");

  // iter13 完成态回归锁：payload 不得再出现身份字段
  assert.ok(!src.includes("username: _username"), "payload must not carry _username");
  assert.ok(!/payload:\s*\{[^}]*\busername\b/s.test(src), "no sendAction payload may contain a username field");
  assert.ok(!src.includes('"_default"'), "no _default pseudo-identity fallback in code");

  // D6 §1：epoch 守卫接线（sessionIdentity import + 在飞丢弃 + 换用户清树监听）
  assert.ok(raw.includes('from "../../shared/state/sessionIdentity.mjs"'), "sessionIdentity must be imported");
  const guardCount = (src.match(/isEpochCurrent\(/g) || []).length;
  assert.ok(guardCount >= 4, `expected >=4 in-flight epoch guards, found ${guardCount}`);
  assert.ok(src.includes('addEventListener("beilu:session-epoch-changed"'), "user-switch cleanup listener required");
  console.log("AUTH_IDENTITY memoryBrowser source contract PASS");
});

Deno.test("sessionIdentity: server-authoritative username, epoch rotation on user switch, stale discard", async () => {
  // 浏览器绑定 shim（diagLogger 顶层 window.addEventListener / CustomEvent 派发）
  if (typeof globalThis.window === "undefined") globalThis.window = globalThis;

  // whoami 桩：可切换当前用户；记录调用次数
  let currentUser = "alice";
  let whoamiCalls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, _opts) => {
    if (String(url).includes("/api/whoami")) {
      whoamiCalls++;
      return Promise.resolve(new Response(JSON.stringify({ username: currentUser, isOwner: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    }
    return Promise.resolve(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
  };

  const events = [];
  const onChanged = (e) => events.push(e.detail);
  globalThis.addEventListener("beilu:session-epoch-changed", onChanged);

  try {
    const mod = await import(
      "../src/public/parts/shells/beilu-chat/public/src/shared/state/sessionIdentity.mjs"
    );
    const { ensureSessionIdentity, getSessionEpoch, isEpochCurrent, getSessionUsername, invalidateSessionEpoch } = mod;

    // 1) 建立身份：username 来自 whoami（服务端权威），epoch 非空且绑定 username
    const idA = await ensureSessionIdentity();
    assert.equal(idA.username, "alice");
    assert.ok(idA.epoch.startsWith("alice#"));
    assert.equal(getSessionUsername(), "alice");
    assert.equal(isEpochCurrent(idA.epoch), true);

    // TTL 内不重复打认证端点
    const callsAfterFirst = whoamiCalls;
    await ensureSessionIdentity();
    assert.equal(whoamiCalls, callsAfterFirst, "TTL window must reuse verified identity");

    // 2) 同 origin 换用户：A 的在飞请求捕获旧 epoch → B 建立后旧结果判丢弃
    const inflightEpochOfA = getSessionEpoch();
    invalidateSessionEpoch("logout"); // logout/401 残留页语义
    assert.equal(isEpochCurrent(inflightEpochOfA), false, "invalidated epoch must reject in-flight results");
    assert.equal(getSessionEpoch(), "", "no identity until re-verified (fail-closed, no guessing)");

    currentUser = "bob";
    const idB = await ensureSessionIdentity();
    assert.equal(idB.username, "bob");
    assert.ok(idB.epoch.startsWith("bob#"));
    assert.notEqual(idB.epoch, inflightEpochOfA);
    assert.equal(isEpochCurrent(inflightEpochOfA), false, "A's stale epoch never matches B's session");
    assert.equal(isEpochCurrent(idB.epoch), true);

    // 3) 事件流：失效 + 建立各有派发，B 的建立事件带前代信息可供清桶方消费
    assert.ok(events.length >= 2, `expected >=2 epoch-changed events, got ${events.length}`);
    const lastEvent = events[events.length - 1];
    assert.equal(lastEvent.username, "bob");

    // 4) whoami 失败 → epoch 作废（守卫端全部拒渲染），不猜身份
    invalidateSessionEpoch("test-reset");
    globalThis.fetch = () => Promise.resolve(new Response("nope", { status: 500 }));
    await assert.rejects(() => ensureSessionIdentity());
    assert.equal(getSessionEpoch(), "");
    assert.equal(isEpochCurrent(idB.epoch), false);
  } finally {
    globalThis.removeEventListener("beilu:session-epoch-changed", onChanged);
    globalThis.fetch = realFetch;
  }
  console.log("AUTH_IDENTITY sessionIdentity unit PASS");
});

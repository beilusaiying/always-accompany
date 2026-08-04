import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  normalizeP1RouteConfig,
  resolveEffectiveP1RouteConfig,
  resolveP1RouteUpdate,
} from "../src/yonban/core/functions/memory/p1Route.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), "utf8");

const handlerSource = read("src/yonban/core/functions/memory/handler/getPromptHandler.mjs");
const setDataSource = read("src/yonban/core/functions/memory/handler/setDataActions.mjs");
const panelSource = read("src/public/parts/shells/beilu-chat/public/src/panels/memory/p1panel.mjs");

// 单源路由规则：有效态原样保留，历史无效态确定性收敛。
assert.deepEqual(normalizeP1RouteConfig({ selfDriven: true, aiP1: false }), { selfDriven: true, aiP1: false });
assert.deepEqual(normalizeP1RouteConfig({ selfDriven: false, aiP1: true }), { selfDriven: false, aiP1: true });
assert.deepEqual(normalizeP1RouteConfig({ selfDriven: true, aiP1: true }), { selfDriven: true, aiP1: false });
assert.deepEqual(normalizeP1RouteConfig({ selfDriven: false, aiP1: false }), { selfDriven: false, aiP1: false });
assert.deepEqual(normalizeP1RouteConfig({}), { selfDriven: false, aiP1: false });

// 旧覆盖只写一个字段时，该字段代表用户最后一次明确选择，不能被声明默认吞掉。
assert.deepEqual(
  resolveEffectiveP1RouteConfig(
    { selfDriven: true, aiP1: false, keep: "declared" },
    { aiP1: true, custom: "override" },
  ),
  { selfDriven: false, aiP1: true, keep: "declared", custom: "override" },
);
assert.deepEqual(
  resolveEffectiveP1RouteConfig({ selfDriven: false, aiP1: true }, { selfDriven: true }),
  { selfDriven: true, aiP1: false },
);
assert.deepEqual(
  resolveEffectiveP1RouteConfig({ selfDriven: true, aiP1: false }, { selfDriven: false, aiP1: false }),
  { selfDriven: false, aiP1: false },
);

assert.deepEqual(resolveP1RouteUpdate({ selfDriven: true }), {
  ok: true,
  config: { selfDriven: true, aiP1: false },
});
assert.deepEqual(resolveP1RouteUpdate({ aiP1: true }), {
  ok: true,
  config: { selfDriven: false, aiP1: true },
});
assert.deepEqual(resolveP1RouteUpdate({ selfDriven: false, aiP1: true }), {
  ok: true,
  config: { selfDriven: false, aiP1: true },
});
assert.equal(resolveP1RouteUpdate({ selfDriven: true, aiP1: true }).code, "E_P1_ROUTE_NOT_EXCLUSIVE");
assert.deepEqual(resolveP1RouteUpdate({ selfDriven: false, aiP1: false }), {
  ok: true,
  config: { selfDriven: false, aiP1: false },
});
assert.deepEqual(resolveP1RouteUpdate(
  { selfDriven: false },
  { selfDriven: false, aiP1: true },
), { ok: true, config: { selfDriven: false, aiP1: true } });
assert.deepEqual(resolveP1RouteUpdate(
  { aiP1: false },
  { selfDriven: true, aiP1: false },
), { ok: true, config: { selfDriven: true, aiP1: false } });
assert.equal(resolveP1RouteUpdate({}).code, "E_P1_ROUTE_MISSING");
assert.equal(resolveP1RouteUpdate({ selfDriven: "true" }).code, "E_P1_ROUTE_TYPE");

// 三个真实契约层必须接同一个 resolver，且 11 的本地→AI 交接实现已移除。
assert.match(handlerSource, /resolveEffectiveP1RouteConfig\(_p1Feat\.config \|\| \{\}, _mfOv\)/);
assert.match(handlerSource, /const _injectSelfDrivenDirectly = _selfDrivenUserEnabled;/);
assert.match(handlerSource, /_p1CurrentRequestHandled = true;/);
assert.match(handlerSource, /extraContext: _vecExtraCtx/);
assert.doesNotMatch(handlerSource, /_buildAIP1LocalPreContext|local_p1_precontext|p1:aiHandoff/);
assert.doesNotMatch(handlerSource, /_selfDrivenUserEnabled\s*&&\s*!_aiP1UserEnabled/);
assert.doesNotMatch(handlerSource, /continuation\s*===\s*["']AIP1["']/);

assert.match(setDataSource, /resolveP1RouteUpdate\(data\)/);
assert.match(setDataSource, /resolveEffectiveP1RouteConfig\(/);
assert.match(setDataSource, /resolveP1RouteUpdate\(data, _mfCurrentRoute\)\.config/);
assert.match(setDataSource, /\.\.\._mfSavedRoute/);
assert.doesNotMatch(setDataSource, /selfDriven:\s*!!data\.selfDriven|aiP1:\s*!!data\.aiP1/);

assert.match(panelSource, /type="checkbox"[^>]+data-mfov-route="selfDriven"/);
assert.match(panelSource, /type="checkbox"[^>]+data-mfov-route="aiP1"/);
assert.match(panelSource, /if \(el\.checked\)/);
assert.match(panelSource, /payload: \{ mode, lib: "p1", selfDriven, aiP1 \}/);
assert.doesNotMatch(panelSource, /data-mfov="[^\"]+:(?:selfDriven|aiP1)"/);

for (const mode of ["chat", "code", "work"]) {
  const json = JSON.parse(read(`src/yonban/pipelines/modes/${mode}.json`));
  assert.equal(json.features.p1.config.selfDriven, true, `${mode} must default to route 10`);
  assert.equal(json.features.p1.config.aiP1, false, `${mode} must default to route 10`);
}

function localResult(label = "A") {
  return {
    directionWords: [`direction-${label}`],
    recalledRecords: [{ recordId: `record-${label}`, content: `local-content-${label}` }],
    runLog: { written: true },
  };
}

class P1HostHarness {
  constructor({
    localFactory = async ({ chatId }) => localResult(chatId),
    aiFactory = async ({ chatId }) => ({ reply: `AIP1 reply for ${chatId}` }),
    cached = [],
  } = {}) {
    this.localFactory = localFactory;
    this.aiFactory = aiFactory;
    this.cached = [...cached];
    this.localInFlight = new Map();
    this.localCalls = 0;
    this.aiCalls = 0;
    this.aiContexts = [];
    this.legacyConsumeCalls = 0;
    this.runLogReports = 0;
  }

  async request({
    selfDriven,
    aiP1,
    chatId = "chat-default",
    automaticOwner = true,
    isFakeSend = false,
  }) {
    const route = normalizeP1RouteConfig({ selfDriven, aiP1 });
    const depthInjections = [];
    let currentRequestHandled = false;

    if (automaticOwner && !isFakeSend && (route.selfDriven || route.aiP1)) {
      currentRequestHandled = true;
      if (route.selfDriven) {
        const key = `user/card/${chatId}/chat/input`;
        let promise = this.localInFlight.get(key);
        const reused = !!promise;
        if (!promise) {
          this.localCalls += 1;
          promise = Promise.resolve(this.localFactory({ chatId }));
          this.localInFlight.set(key, promise);
        }
        try {
          const local = await promise;
          if (!reused) this.runLogReports += 1;
          if (local.directionWords.length > 0) {
            depthInjections.push({ id: "INJ-p1-act-data", content: local.directionWords.join(" / ") });
          }
          if (local.recalledRecords.length > 0) {
            depthInjections.push({ id: "INJ-p1-retrieval-data", content: local.recalledRecords[0].content });
          }
        } finally {
          if (!reused && this.localInFlight.get(key) === promise) this.localInFlight.delete(key);
        }
      } else if (route.aiP1) {
        this.aiCalls += 1;
        const extraContext = "vector-context-only";
        this.aiContexts.push({ chatId, extraContext });
        try {
          const result = await this.aiFactory({ chatId, extraContext });
          const reply = String(result?.reply || "").trim();
          if (reply.length >= 5) depthInjections.push({ id: "INJ-p1-retrieval-data", content: reply });
        } catch {
          // 01 失败时保持零 P1 注入，不切换到 10，也不偷旧缓存。
        }
      }
    }

    const alreadyInjected = depthInjections.some((item) => item.id === "INJ-p1-retrieval-data");
    if (!alreadyInjected && !currentRequestHandled && !isFakeSend && this.cached.length > 0) {
      this.legacyConsumeCalls += 1;
      depthInjections.push({ id: "INJ-p1-retrieval-data", content: this.cached.shift() });
    }
    return { depthInjections, route };
  }
}

const routeCases = [
  { raw: { selfDriven: true, aiP1: false }, effective: "10", localCalls: 1, aiCalls: 0, ids: ["INJ-p1-act-data", "INJ-p1-retrieval-data"] },
  { raw: { selfDriven: false, aiP1: true }, effective: "01", localCalls: 0, aiCalls: 1, ids: ["INJ-p1-retrieval-data"] },
  { raw: { selfDriven: true, aiP1: true }, effective: "10", localCalls: 1, aiCalls: 0, ids: ["INJ-p1-act-data", "INJ-p1-retrieval-data"] },
  { raw: { selfDriven: false, aiP1: false }, effective: "00", localCalls: 0, aiCalls: 0, ids: [] },
];

for (const expected of routeCases) {
  const harness = new P1HostHarness({
    cached: expected.effective === "00" ? [] : ["must-not-bypass-current-owner"],
  });
  const result = await harness.request(expected.raw);
  assert.equal(harness.localCalls, expected.localCalls, `${expected.effective} local call count`);
  assert.equal(harness.aiCalls, expected.aiCalls, `${expected.effective} AI P1 call count`);
  assert.deepEqual(result.depthInjections.map((item) => item.id), expected.ids, `${expected.effective} injection contract`);
  assert.equal(harness.legacyConsumeCalls, 0, `${expected.effective} must not consume legacy cache`);
  assert.equal(result.route.selfDriven && result.route.aiP1, false, `${expected.effective} must never become 11`);
  if (expected.aiCalls === 1) {
    assert.equal(harness.aiContexts[0].extraContext, "vector-context-only");
    assert.doesNotMatch(harness.aiContexts[0].extraContext, /local_p1_precontext|local-content/);
  }
}

const offHarness = new P1HostHarness({ cached: ["explicit manual P1 result"] });
const offResult = await offHarness.request({ selfDriven: false, aiP1: false });
assert.deepEqual(offResult.depthInjections, [{
  id: "INJ-p1-retrieval-data",
  content: "explicit manual P1 result",
}], "00 must run neither automatic route and may consume one explicit manual P1 result");
assert.equal(offHarness.localCalls, 0);
assert.equal(offHarness.aiCalls, 0);
assert.equal(offHarness.legacyConsumeCalls, 1);

const failedAiHarness = new P1HostHarness({
  aiFactory: async () => { throw new Error("AIP1 unavailable"); },
  cached: ["must-not-fallback"],
});
const failedAi = await failedAiHarness.request({ selfDriven: false, aiP1: true });
assert.deepEqual(failedAi.depthInjections, [], "01 failure must produce no P1 injection");
assert.equal(failedAiHarness.localCalls, 0, "01 failure must not start self-driven P1");
assert.equal(failedAiHarness.legacyConsumeCalls, 0, "01 failure must not consume a cached fallback");

const isolatedHarness = new P1HostHarness({ localFactory: ({ chatId }) => localResult(chatId) });
const [chatA, chatB] = await Promise.all([
  isolatedHarness.request({ selfDriven: true, aiP1: false, chatId: "chat-A" }),
  isolatedHarness.request({ selfDriven: true, aiP1: false, chatId: "chat-B" }),
]);
assert.equal(isolatedHarness.localCalls, 2, "different chatId scopes must not share a local run");
assert.match(chatA.depthInjections[1].content, /chat-A/);
assert.doesNotMatch(chatA.depthInjections[1].content, /chat-B/);
assert.match(chatB.depthInjections[1].content, /chat-B/);
assert.doesNotMatch(chatB.depthInjections[1].content, /chat-A/);

let releaseSharedRun;
const sharedRun = new Promise((resolve) => { releaseSharedRun = resolve; });
const singleFlightHarness = new P1HostHarness({ localFactory: () => sharedRun });
const first = singleFlightHarness.request({ selfDriven: true, aiP1: false, chatId: "same-chat" });
const second = singleFlightHarness.request({ selfDriven: true, aiP1: false, chatId: "same-chat" });
await Promise.resolve();
assert.equal(singleFlightHarness.localCalls, 1, "same-key concurrent requests must call runP1 once");
releaseSharedRun(localResult("shared"));
const [firstResult, secondResult] = await Promise.all([first, second]);
assert.deepEqual(firstResult.depthInjections, secondResult.depthInjections);
assert.equal(singleFlightHarness.runLogReports, 1, "shared local runLog issue must be reported once");

const fakeSendHarness = new P1HostHarness({ cached: ["must-survive-fake-send"] });
const fakeSend = await fakeSendHarness.request({
  selfDriven: true,
  aiP1: false,
  automaticOwner: false,
  isFakeSend: true,
});
assert.deepEqual(fakeSend.depthInjections, []);
assert.equal(fakeSendHarness.legacyConsumeCalls, 0);
assert.deepEqual(fakeSendHarness.cached, ["must-survive-fake-send"]);

const manualHarness = new P1HostHarness({ cached: ["manual P1 result"] });
const manual = await manualHarness.request({
  selfDriven: true,
  aiP1: false,
  automaticOwner: false,
});
assert.deepEqual(manual.depthInjections, [{ id: "INJ-p1-retrieval-data", content: "manual P1 result" }]);
assert.equal(manualHarness.legacyConsumeCalls, 1, "manual P1 remains consumable when automatic Phase3 did not take ownership");

console.log("P1 at-most-one 10/01/00 route contracts: PASS");

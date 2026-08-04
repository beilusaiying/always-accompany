/**
 * readiness_pet_stt.e2e.mjs — D5 白盒 E2E 场景（【本文件尚未运行过：未验证】）。
 *
 * ⚠ 运行前提（D5 §5：静态测试不能证明的层，全部在此）：
 *   全新用户 + 全新浏览器 profile + 真实 Electron + 真实/受限带宽网络 + 真实 beilu 服务进程。
 *   执行方式由凛倾决定（「别沙盒」：本窗口只交付场景脚本与断言口径，不擅自起服/起浏览器/起 Electron）。
 *   运行：node tests/readiness_pet_stt.e2e.mjs --base http://localhost:1315 （建议打在沙盒端口实例上）
 *
 * 覆盖场景（D5 §5 表）：
 *   1. 冷启动阶段可见：/api/readiness 从 LISTENING→SHELL_READY→BACKGROUND_PRELOAD 有序推进,
 *      shellReady 早于 backgroundPreload.done（基础聊天先于全 Part 预载可交互）。
 *   2. 桌宠四象限：原开/原关 × start/stopGameCompanion；lease release 不误关 explicit pet；
 *      stop 回包 pet 分项（runtime/stopTimeout）与真实 Electron 进程存活一致。
 *   3. STT：auto 三源 probe 全失败(断网/防火墙模拟)但任一源 list 可用仍进入 transferring；
 *      cancel → phase=cancelled 且 .part 保留；再次下载从 resumeBytes 续传。
 * 保存产物：readiness/job timeline JSON 落盘到 --out 目录（验收留档）。
 */
import assert from "node:assert/strict";

const BASE = (() => {
  const i = process.argv.indexOf("--base");
  return i > 0 ? process.argv[i + 1] : "http://localhost:1314";
})();

async function j(path, init) {
  const r = await fetch(BASE + path, init);
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function main() {
  const timeline = [];
  const record = (tag, data) => timeline.push({ tag, at: new Date().toISOString(), data });

  // ── 场景 1：readiness 分层 ──
  const ping = await j("/api/ping");
  assert.equal(ping.status, 200, "liveness 应可答");
  const rd = await j("/api/readiness");
  assert.equal(rd.status, 200, "readiness 端点应存在（与 ping 分离）");
  record("readiness", rd.body);
  assert.ok(["PROCESS_START", "LISTENING", "SHELL_READY", "BACKGROUND_PRELOAD"].includes(rd.body.stage));
  if (rd.body.shellReady) {
    // 基础聊天先于后台全 Part 预载可交互：shellReady=true 时 backgroundPreload 可以仍在 running
    record("shellReady-vs-preload", rd.body.backgroundPreload);
  }

  // ── 场景 2/3 需要认证 session 与真实 Electron/网络，此处只探端点形状（完整交互由执行人按上方口径操作） ──
  const pet = await j("/api/eye/pet-settings");
  if (pet.status === 200) {
    assert.ok("petEffectiveDesired" in pet.body, "pet-settings 非 raw 响应应含 petEffectiveDesired（Electron 退出判据）");
    assert.ok("petRuntime" in pet.body, "pet-settings 非 raw 响应应含 petRuntime 镜像");
    record("pet-settings", { petEnabled: pet.body.petEnabled, petEffectiveDesired: pet.body.petEffectiveDesired, runtime: pet.body.petRuntime?.status });
  }

  const outIdx = process.argv.indexOf("--out");
  if (outIdx > 0) {
    const fs = await import("node:fs");
    fs.writeFileSync(process.argv[outIdx + 1] + "/readiness_timeline.json", JSON.stringify(timeline, null, 2));
  }
  console.log("[e2e] 端点形状探测通过；完整四象限/STT 续传场景需按文件头前提人工/受控执行。");
  console.log(JSON.stringify(timeline, null, 2));
}

main().catch((e) => { console.error("[e2e] 失败:", e.message); process.exit(1); });

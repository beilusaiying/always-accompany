import assert from "node:assert/strict";
import {
  sampleProcessTree,
  startCommandWatchdog,
} from "./tools/process-telemetry.mjs";
import {
  disposeShellSession,
  runCommand,
  runScript,
} from "./tools/command-tools.mjs";
import { ToolExecutor } from "./executor.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function policy(action, stallMs) {
  return {
    command_watchdog_enabled: true,
    command_watchdog_action: action,
    command_watchdog_stall_ms: stallMs,
    command_watchdog_sample_ms: 1000,
    command_watchdog_cpu_delta_ms: 10,
    command_watchdog_rss_delta_bytes: 1048576,
    command_watchdog_progress_ms: 1000,
  };
}

async function testSamplerUnavailableNeverStalls() {
  let stalls = 0;
  const progress = [];
  const watchdog = startCommandWatchdog({
    rootPid: process.pid,
    runtimePolicy: {
      ...policy("terminate", 3000),
      command_watchdog_sample_ms: 500,
      command_watchdog_progress_ms: 500,
    },
    readOutputBytes: () => 0,
    sampler: async () => ({
      available: false,
      rootPid: process.pid,
      alive: true,
      processCount: null,
      cpuTimeMs: null,
      rssBytes: null,
      gpuAvailable: false,
      error: "synthetic_unavailable",
    }),
    onProgress: (value) => progress.push(value),
    onStall: () => { stalls++; },
  });
  await delay(1800);
  watchdog.stop();
  assert.equal(stalls, 0);
  assert.ok(progress.some((item) => item.phase === "telemetry_unavailable"));
}

async function testQuietProcessTerminates() {
  const progress = [];
  const started = Date.now();
  const result = await runScript({
    lang: "node",
    code: "setTimeout(() => {}, 30000);",
    cwd: process.cwd(),
    timeout: 15000,
  }, {
    runtimePolicy: policy("terminate", 4000),
    onProgress: (value) => progress.push(value),
  });
  const elapsed = Date.now() - started;
  assert.equal(result.success, false);
  assert.equal(result.stalled, true);
  assert.equal(result.errorCode, "command_stalled");
  assert.ok(elapsed >= 3500 && elapsed < 14000, `unexpected stall elapsed=${elapsed}`);
  assert.ok(progress.some((item) => item.phase === "stalled"));
  assert.equal(result.processTermination?.attempted, true);
  assert.equal(result.processTermination?.stopped, true);
  const pid = Number(result.stall?.pid);
  if (Number.isSafeInteger(pid) && pid > 0) {
    await delay(300);
    const after = await sampleProcessTree(pid);
    assert.equal(after.available, true);
    assert.equal(after.alive, false);
  }
}

async function testOutputActivityPreventsStall() {
  const progress = [];
  const result = await runScript({
    lang: "node",
    code: "let n=0; const t=setInterval(()=>console.log('tick', ++n), 700); setTimeout(()=>{clearInterval(t); process.exit(0)}, 5200);",
    cwd: process.cwd(),
    timeout: 12000,
  }, {
    runtimePolicy: policy("terminate", 3000),
    onProgress: (value) => progress.push(value),
  });
  assert.equal(result.stalled, undefined);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /tick/);
  assert.ok(progress.some((item) => Number(item.outputBytes) > 0));
}

async function testCpuActivityPreventsStall() {
  const result = await runScript({
    lang: "node",
    code: "const end=Date.now()+5200; let x=0; while(Date.now()<end){x=Math.sqrt(x+12345)}; process.exit(Number.isFinite(x)?0:1);",
    cwd: process.cwd(),
    timeout: 12000,
  }, {
    runtimePolicy: policy("terminate", 3000),
  });
  assert.equal(result.stalled, undefined);
  assert.equal(result.exitCode, 0);
}

async function testReportModeFallsThroughToHardTimeout() {
  const progress = [];
  const result = await runScript({
    lang: "node",
    code: "setTimeout(() => {}, 30000);",
    cwd: process.cwd(),
    timeout: 6500,
  }, {
    runtimePolicy: policy("report", 3000),
    onProgress: (value) => progress.push(value),
  });
  assert.equal(result.stalled, undefined);
  assert.equal(result.timedOut, true);
  assert.equal(result.errorCode, "command_timeout");
  assert.ok(progress.some((item) => item.phase === "stalled" && item.watchdogAction === "report"));
}

async function testExecutorPrivatePolicyAndProgress() {
  const executor = new ToolExecutor(process.cwd());
  const progress = [];
  const result = await executor.execute({
    id: "watchdog-executor-contract",
    tool: "run_script",
    params: {
      lang: "node",
      code: "setTimeout(() => {}, 30000);",
      cwd: process.cwd(),
      timeout: 12000,
    },
    chatid: "watchdog-test-chat",
    transport: {
      ownerUsername: "002",
      runtimePolicy: policy("terminate", 3000),
    },
  }, {
    onProgress: (value) => progress.push(value),
  });
  assert.equal(result.success, false);
  assert.equal(result.result?.stalled, true);
  assert.equal(result.result?.errorCode, "command_stalled");
  assert.ok(progress.some((item) => item.phase === "stalled"));
}

async function testNonzeroExitFails() {
  const executor = new ToolExecutor(process.cwd());
  const result = await executor.execute({
    id: "watchdog-nonzero-contract",
    tool: "run_command",
    params: {
      command: process.platform === "win32" ? "cmd /c exit /b 7" : "sh -c \"exit 7\"",
      cwd: process.cwd(),
      timeout: 5000,
    },
    chatid: "watchdog-test-chat",
    transport: {
      runtimePolicy: { command_watchdog_enabled: false },
    },
  });
  assert.equal(result.success, false);
  assert.equal(result.result?.success, false);
  assert.equal(result.result?.exitCode, 7);
  assert.equal(result.result?.errorCode, "command_exit_nonzero");
  assert.equal(result.result?._debug?.success, false);
}

async function testOutputLimitFails() {
  const result = await runScript({
    lang: "node",
    code: "process.stdout.write('x'.repeat(2 * 1024 * 1024));",
    cwd: process.cwd(),
    timeout: 10000,
  }, {
    runtimePolicy: { command_watchdog_enabled: false },
  });
  assert.equal(result.success, false);
  assert.equal(result.errorCode, "command_output_limit");
  assert.equal(result.maxBufferExceeded, true);
  assert.match(result.truncatedHint, /执行被中止且结果不完整/);
}

async function testPersistentSessionTerminates() {
  if (process.platform !== "win32") return;
  const sessionKey = "watchdog-persistent-session-test";
  try {
    const result = await runCommand({
      command: "powershell.exe -NoProfile -NonInteractive -Command Start-Sleep -Seconds 30",
      cwd: process.cwd(),
      timeout: 12000,
      session: true,
      session_key: sessionKey,
    }, {
      runtimePolicy: policy("terminate", 3000),
    });
    assert.equal(result.stalled, true);
    assert.equal(result.errorCode, "command_stalled");
    assert.equal(result.session, true);
    assert.equal(result.processTermination?.attempted, true);
    assert.equal(result.processTermination?.stopped, true);
    const recovered = await runCommand({
      command: "echo session-recovered",
      cwd: process.cwd(),
      timeout: 5000,
      session: true,
      session_key: sessionKey,
    }, {
      runtimePolicy: { command_watchdog_enabled: false },
    });
    assert.equal(recovered.exitCode, 0);
    assert.match(recovered.stdout, /session-recovered/);
  } finally {
    disposeShellSession(sessionKey);
  }
}

async function testPersistentSessionHardTimeout() {
  if (process.platform !== "win32") return;
  const sessionKey = "watchdog-persistent-timeout-test";
  try {
    const result = await runCommand({
      command: "powershell.exe -NoProfile -NonInteractive -Command Start-Sleep -Seconds 30",
      cwd: process.cwd(),
      timeout: 2500,
      session: true,
      session_key: sessionKey,
    }, {
      runtimePolicy: { command_watchdog_enabled: false },
    });
    assert.equal(result.success, false);
    assert.equal(result.timedOut, true);
    assert.equal(result.errorCode, "command_timeout");
    assert.equal(result.processTermination?.attempted, true);
    assert.equal(result.processTermination?.stopped, true);
  } finally {
    disposeShellSession(sessionKey);
  }
}

async function testPersistentSessionNonzeroExitFails() {
  if (process.platform !== "win32") return;
  const sessionKey = "watchdog-persistent-nonzero-test";
  try {
    const result = await runCommand({
      command: "cmd /c exit /b 9",
      cwd: process.cwd(),
      timeout: 5000,
      session: true,
      session_key: sessionKey,
    }, {
      runtimePolicy: { command_watchdog_enabled: false },
    });
    assert.equal(result.success, false);
    assert.equal(result.exitCode, 9);
    assert.equal(result.errorCode, "command_exit_nonzero");
  } finally {
    disposeShellSession(sessionKey);
  }
}

const current = await sampleProcessTree(process.pid);
assert.equal(current.available, true);
assert.equal(current.alive, true);

await testSamplerUnavailableNeverStalls();
await testQuietProcessTerminates();
await testOutputActivityPreventsStall();
await testCpuActivityPreventsStall();
await testReportModeFallsThroughToHardTimeout();
await testExecutorPrivatePolicyAndProgress();
await testNonzeroExitFails();
await testOutputLimitFails();
await testPersistentSessionTerminates();
await testPersistentSessionHardTimeout();
await testPersistentSessionNonzeroExitFails();

console.log(JSON.stringify({
  pass: true,
  tests: [
    "sampler_unavailable_never_stalls",
    "quiet_process_terminates",
    "output_activity_prevents_stall",
    "cpu_activity_prevents_stall",
    "report_mode_falls_through_to_hard_timeout",
    "executor_private_policy_and_progress",
    "nonzero_exit_fails",
    "output_limit_fails",
    "persistent_session_terminates",
    "persistent_session_hard_timeout",
    "persistent_session_nonzero_exit_fails",
  ],
}));

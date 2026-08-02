import assert from "node:assert/strict";
import fs from "node:fs";
import {
  ToolJobRegistry,
  buildToolIoRuntimePolicy,
  normalizeToolRuntimeConfig,
  normalizeToolRuntimeConfigForRecovery,
} from "../src/yonban/core/transport/toolRuntime.mjs";
import { formatToolResultsForInjection } from "../src/yonban/core/transport/ideTagParser.mjs";

const defaults = normalizeToolRuntimeConfig();
assert.equal(defaults.command_watchdog_enabled, true);
assert.equal(defaults.command_watchdog_action, "terminate");
assert.equal(defaults.notify_stalled, true);
assert.ok(defaults.command_watchdog_stall_ms >= defaults.command_watchdog_sample_ms * 2);

const report = normalizeToolRuntimeConfig({
  command_watchdog_enabled: true,
  command_watchdog_action: "report",
  command_watchdog_stall_ms: 5000,
  command_watchdog_sample_ms: 4000,
  command_watchdog_cpu_delta_ms: 7,
  command_watchdog_rss_delta_bytes: 65536,
  command_watchdog_progress_ms: 3000,
});
assert.equal(report.command_watchdog_action, "report");
assert.equal(report.command_watchdog_stall_ms, 8000);

const recovery = normalizeToolRuntimeConfigForRecovery(null);
assert.equal(recovery.command_watchdog_enabled, false);
assert.equal(recovery.command_watchdog_action, "report");
assert.equal(recovery.notify_stalled, false);

const policy = buildToolIoRuntimePolicy(report);
assert.deepEqual({
  enabled: policy.command_watchdog_enabled,
  action: policy.command_watchdog_action,
  stall: policy.command_watchdog_stall_ms,
  sample: policy.command_watchdog_sample_ms,
  cpu: policy.command_watchdog_cpu_delta_ms,
  rss: policy.command_watchdog_rss_delta_bytes,
  progress: policy.command_watchdog_progress_ms,
}, {
  enabled: true,
  action: "report",
  stall: 8000,
  sample: 4000,
  cpu: 7,
  rss: 65536,
  progress: 3000,
});

const jobs = new ToolJobRegistry();
const created = jobs.create({
  requestId: "req-watchdog",
  chatid: "chat-watchdog",
  ownerUsername: "002",
  tool: "run_script",
  params: { lang: "node" },
});
jobs.update(created.jobId, {
  state: "running",
  progress: {
    phase: "running",
    pid: 1234,
    cpuDeltaMs: 50,
    rssBytes: 1048576,
    outputBytes: 12,
    idleForMs: 1000,
  },
});
const snapshot = jobs.publicSnapshot(created.jobId, "002");
assert.equal(snapshot.progress.phase, "running");
assert.equal(snapshot.progress.pid, 1234);

const html = fs.readFileSync(
  new URL("../src/public/parts/shells/beilu-chat/public/index.html", import.meta.url),
  "utf8",
);
for (const id of [
  "ide-tool-command-watchdog-enabled",
  "ide-tool-command-watchdog-terminate",
  "ide-tool-command-watchdog-stall-ms",
  "ide-tool-command-watchdog-sample-ms",
  "ide-tool-command-watchdog-cpu-delta-ms",
  "ide-tool-command-watchdog-rss-delta-bytes",
  "ide-tool-command-watchdog-progress-ms",
  "ide-tool-notify-stalled",
]) {
  assert.match(html, new RegExp(`id="${id}"`));
}

const ideClient = fs.readFileSync(
  new URL("../src/yonban/core/transport/ideClient.mjs", import.meta.url),
  "utf8",
);
assert.match(ideClient, /case "tool_progress"/);
assert.match(ideClient, /_publishWorkerToolLifecycle\(pending, "progress"/);
assert.match(ideClient, /"started", "progress", "wait_timeout"/);

const stalledReceipt = formatToolResultsForInjection([{
  tool: "run_command",
  timestamp: "2026-07-29T22:00:00.000Z",
  result: {
    success: false,
    error: "command_stalled",
    result: {
      success: false,
      errorCode: "command_stalled",
      exitCode: -1,
      stalled: true,
      stall: {
        phase: "stalled",
        pid: 1234,
        idleForMs: 60000,
        cpuDeltaMs: 0,
        rssDeltaBytes: 0,
        outputDeltaBytes: 0,
      },
      processTermination: { attempted: true, stopped: true, error: null },
      stdout: "partial output",
      stderr: "last error",
    },
  },
}]);
assert.match(stalledReceipt, /\[tool_failure\].*"errorCode":"command_stalled"/);
assert.match(stalledReceipt, /"idleForMs":60000/);
assert.match(stalledReceipt, /\[stdout\] partial output/);
assert.match(stalledReceipt, /\[stderr\] last error/);

console.log(JSON.stringify({
  pass: true,
  defaults: {
    enabled: defaults.command_watchdog_enabled,
    action: defaults.command_watchdog_action,
    stallMs: defaults.command_watchdog_stall_ms,
    sampleMs: defaults.command_watchdog_sample_ms,
  },
  progressRoundTrip: snapshot.progress,
}));

import assert from "node:assert/strict";
import fs from "node:fs";

import { getP1RunLogIssues } from "../src/public/parts/shells/beilu-chat/public/src/panels/memory/p1panel.mjs";

const handlerPath = new URL("../src/yonban/core/functions/memory/handler/getPromptHandler.mjs", import.meta.url);
const panelPath = new URL("../src/public/parts/shells/beilu-chat/public/src/panels/memory/p1panel.mjs", import.meta.url);
const handlerSource = fs.readFileSync(handlerPath, "utf8");
const panelSource = fs.readFileSync(panelPath, "utf8");

function extractExportedFunction(source, name) {
  const marker = `export function ${name}`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${name} export is missing`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1).replaceAll("\r\n", "\n");
  }
  assert.fail(`${name} export is not closed`);
}

assert.deepEqual(getP1RunLogIssues({ runLog: { enabled: true, written: true, code: "P1_RUN_LOG_WRITTEN" } }), []);
assert.deepEqual(getP1RunLogIssues({ runLog: { enabled: false, written: false, code: "E_DISABLED" } }), []);
assert.deepEqual(getP1RunLogIssues({ runLog: { enabled: true, written: false, code: "P1_RUN_LOG_SKIPPED_LIGHTWEIGHT" } }), []);

const successfulRecall = {
  success: true,
  outcome: "recall",
  directionWords: ["关联词"],
  recalledRecords: [{ recordId: "r-1", content: "召回内容" }],
  runLog: {
    enabled: true,
    written: false,
    code: "E_P1_RUN_LOG_WRITE",
    error: "disk unavailable",
    file: "p1-run-20260803.jsonl",
    path: "D:\\private\\must-not-render.jsonl",
  },
};
const before = structuredClone(successfulRecall);
assert.deepEqual(getP1RunLogIssues(successfulRecall), [{
  component: "runLog",
  severity: "error",
  kind: "write",
  written: false,
  stage: "write",
  code: "E_P1_RUN_LOG_WRITE",
  message: "disk unavailable",
  file: "p1-run-20260803.jsonl",
}]);
assert.deepEqual(successfulRecall, before, "runLog mapping must not mutate the successful recall result");
assert.equal(successfulRecall.success, true);
assert.equal(successfulRecall.outcome, "recall");
assert.deepEqual(successfulRecall.recalledRecords, [{ recordId: "r-1", content: "召回内容" }]);

const pruneDiagnostic = {
  success: true,
  outcome: "recall",
  recalledRecords: [{ recordId: "r-2", content: "仍然召回" }],
  runLog: {
    enabled: true,
    written: true,
    code: "P1_RUN_LOG_WRITTEN",
    file: "p1_runs_2026-08-03.jsonl",
    diagnostics: {
      errors: [
        { code: "E_P1_RUN_LOG_PRUNE_DELETE", stage: "prune-delete", exception: "PermissionError", file: "p1_runs_2026-07-01.jsonl" },
        { code: "E_P1_RUN_LOG_PRUNE_DELETE", stage: "prune-delete", exception: "PermissionError", file: "p1_runs_2026-07-01.jsonl" },
      ],
      warnings: [
        { code: "E_P1_RUN_LOG_PRUNE_DELETE", stage: "prune-delete", exception: "PermissionError", file: "p1_runs_2026-07-01.jsonl" },
        { code: "E_P1_RUN_LOG_PRUNE_WARNING", stage: "prune-warning", exception: "OSError" },
        { code: "P1_RUN_LOG_PRUNE_INVALID_DATE", stage: "prune-name", exception: "ValueError" },
      ],
    },
  },
};
const pruneBefore = structuredClone(pruneDiagnostic);
assert.deepEqual(getP1RunLogIssues(pruneDiagnostic), [{
  component: "runLog",
  severity: "error",
  kind: "diagnostic",
  written: true,
  stage: "prune-delete",
  code: "E_P1_RUN_LOG_PRUNE_DELETE",
  message: "PermissionError: P1 run log prune-delete failed",
  file: "p1_runs_2026-07-01.jsonl",
}, {
  component: "runLog",
  severity: "warning",
  kind: "diagnostic",
  written: true,
  stage: "prune-delete",
  code: "E_P1_RUN_LOG_PRUNE_DELETE",
  message: "PermissionError: P1 run log prune-delete failed",
  file: "p1_runs_2026-07-01.jsonl",
}, {
  component: "runLog",
  severity: "warning",
  kind: "diagnostic",
  written: true,
  stage: "prune-warning",
  code: "E_P1_RUN_LOG_PRUNE_WARNING",
  message: "OSError: P1 run log prune-warning failed",
  file: "p1_runs_2026-08-03.jsonl",
}, {
  component: "runLog",
  severity: "warning",
  kind: "diagnostic",
  written: true,
  stage: "prune-name",
  code: "P1_RUN_LOG_PRUNE_INVALID_DATE",
  message: "ValueError: P1 run log prune-name failed",
  file: "p1_runs_2026-08-03.jsonl",
}], "issues deduplicate by severity+code+message+file while preserving warning severity");
assert.deepEqual(pruneDiagnostic, pruneBefore, "diagnostic mapping must not mutate the successful written receipt or recall");
assert.equal(pruneDiagnostic.runLog.written, true);
assert.deepEqual(pruneDiagnostic.recalledRecords, [{ recordId: "r-2", content: "仍然召回" }]);

const realPruneWarning = {
  success: true,
  recalledRecords: [{ recordId: "r-3", content: "警告不反转召回" }],
  runLog: {
    enabled: true,
    written: true,
    code: "P1_RUN_LOG_WRITTEN",
    file: "p1_runs_2026-08-03.jsonl",
    diagnostics: {
      warnings: [{ stage: "prune-name", code: "P1_RUN_LOG_PRUNE_INVALID_DATE" }],
      errors: [],
    },
  },
};
const realWarningBefore = structuredClone(realPruneWarning);
const realWarningIssues = getP1RunLogIssues(realPruneWarning);
assert.equal(realWarningIssues.length, 1, "real prune warning shape must produce one public issue");
assert.deepEqual(realWarningIssues[0], {
  component: "runLog",
  severity: "warning",
  kind: "diagnostic",
  written: true,
  stage: "prune-name",
  code: "P1_RUN_LOG_PRUNE_INVALID_DATE",
  message: "P1 run log prune-name failed",
  file: "p1_runs_2026-08-03.jsonl",
});
assert.deepEqual(realPruneWarning, realWarningBefore);
assert.deepEqual(realPruneWarning.recalledRecords, [{ recordId: "r-3", content: "警告不反转召回" }]);

assert.equal(
  extractExportedFunction(handlerSource, "getP1RunLogIssues"),
  extractExportedFunction(panelSource, "getP1RunLogIssues"),
  "host and panel must use the same runLog issue predicate/mapping",
);

const reportGate = "if (_p1Res?.success === true && _runLogIssues.length > 0 && !_p1RunReused)";
const reportGateIndex = handlerSource.indexOf(reportGate);
const overallFailureIndex = handlerSource.indexOf("if (_p1Res?.success !== true)", reportGateIndex);
assert.notEqual(reportGateIndex, -1, "host runLog failure report gate is missing");
assert.ok(overallFailureIndex > reportGateIndex, "runLog side-effect report must remain separate from overall P1 failure handling");
assert.ok(handlerSource.includes("for (const _runLogIssue of _runLogIssues)"), "host must report every unique mapped issue");
assert.ok(handlerSource.includes('wbD(chatId, "runLog", `p1:${detail.severity}`'), "host must emit a severity-tagged runLog wbD");
assert.ok(handlerSource.includes("console.error(`[P1-runLog] error:"), "host must emit the stable error monitor prefix");
assert.ok(handlerSource.includes("console.warn(`[P1-runLog] warning:"), "host must emit the stable warning monitor prefix");

assert.ok(panelSource.includes('"运行记录写入失败"') && panelSource.includes("召回结果仍有效"), "panel must visibly distinguish runLog failure from recall failure");
assert.ok(panelSource.includes("记录已写入但清理错误"), "panel must distinguish prune errors after a successful write");
assert.ok(panelSource.includes("记录已写入但清理警告"), "panel must distinguish prune warnings after a successful write");
assert.ok(panelSource.includes("_esc(issue.file)"), "panel must render each issue file token");
assert.ok(!panelSource.includes("issue.path"), "panel must not render an absolute runLog path");

console.log("P1 runLog consumer contracts: PASS");

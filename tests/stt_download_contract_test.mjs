/**
 * stt_download_contract_test.mjs — STT 下载 Job DTO 与终态收束契约（D5 §2.3）。
 * 只 import download_job_model.mjs 叶子；真实网络传输/续传/换源属静态不可判定点：
 * 未验证，归 E2E（readiness_pet_stt.e2e.mjs，未运行）。probe 只排序不作准入已由 iter7 落地，
 * 其行为断言依赖真实网络，此处只锁 DTO/终态合同。
 */
import assert from "node:assert/strict";

import {
  createDownloadJobState,
  finalizeDownloadJobState,
} from "../src/public/parts/plugins/beilu-stt/download_job_model.mjs";

Deno.test("Job DTO 字段合同完整（D5 §2.3 列举字段一个不缺）", () => {
  const job = createDownloadJobState("auto");
  for (const field of [
    "jobId", "phase", "sourceOrder", "probe", "retries", "resumeBytes",
    "currentFile", "doneBytes", "totalBytes", "speedBps", "etaS", "terminalReason",
    "running", "source", "filesTotal", "filesDone", "note", "error", "finished",
  ]) {
    assert.ok(field in job, `Job DTO 缺字段: ${field}`);
  }
  assert.equal(job.phase, "selecting");
  assert.equal(job.running, true);
  assert.equal(job.error, null);
  assert.equal(job.terminalReason, null);
  // jobId 每任务唯一
  assert.notEqual(createDownloadJobState("hf").jobId, job.jobId);
});

Deno.test("取消收束为 cancelled：不是 error、.part 语义=保留续传、note 明示", () => {
  const t = finalizeDownloadJobState({ aborted: true, finished: false, errorMessage: "已取消" });
  assert.equal(t.phase, "cancelled");
  assert.equal(t.terminalReason, "cancelled");
  assert.equal(t.error, null, "取消不得写进 error 字段（D5 §2.3：取消不是 error）");
  assert.equal(t.running, false);
  assert.equal(t.finished, false);
  assert.match(t.note, /已保留/);
});

Deno.test("完成收束为 completed，失败收束为 failed 且 terminalReason=原因", () => {
  const done = finalizeDownloadJobState({ aborted: false, finished: true, errorMessage: null });
  assert.equal(done.phase, "completed");
  assert.equal(done.terminalReason, null);
  assert.equal(done.error, null);

  const fail = finalizeDownloadJobState({ aborted: false, finished: false, errorMessage: "所有下载源不可达(文件列表均失败): hf: timeout" });
  assert.equal(fail.phase, "failed");
  assert.match(fail.terminalReason, /所有下载源不可达/);
  assert.equal(fail.error, fail.terminalReason);
});

Deno.test("取消优先于错误：abort 竞态下错误信息不得把终态改写成 failed", () => {
  const t = finalizeDownloadJobState({ aborted: true, finished: false, errorMessage: "fetch aborted" });
  assert.equal(t.phase, "cancelled");
  assert.equal(t.error, null);
});

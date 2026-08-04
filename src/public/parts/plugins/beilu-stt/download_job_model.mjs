/**
 * download_job_model.mjs — STT 模型下载 Job 的 DTO 形状与终态收束（纯函数叶子，零依赖）。
 *
 * 【功能链】(D5 §2.3)
 *   POST /model/download → main.mjs 建 job(createDownloadJobState) → 后台任务推进
 *   (phase: selecting→transferring;/model/cancel → cancelling) → 后台任务 finally 收束
 *   (finalizeDownloadJobState:completed/cancelled/failed) → 前端 /model/progress 轮询消费。
 *
 * 【why 独立叶子】
 *   1) 终态语义是合同:取消不是 error(`.part` 保留可续传,error 字段必须为 null),
 *      「cancelling 只在所有在途 list/probe/transfer 收束后才写 terminal cancelled」——
 *      纯函数化后 tests/stt_download_contract_test.mjs 可直接断言,不必拉起真实下载。
 *   2) main.mjs import auth 等大依赖图,测试无法安全 import;本叶子零依赖。
 *
 * 【关联链】← main.mjs(唯一消费者) ← tests/stt_download_contract_test.mjs
 * 【使用效果】取消后 UI 显示「已取消，已下载部分已保留，下次继续」而非「下载失败」;
 *   probe 全失败不再伪装成下载失败(phase/terminalReason 分项可读)。
 */

/** Job DTO 全字段(D5 §2.3 合同)。abort 控制器由 main.mjs 另持,不进 DTO。 */
export function createDownloadJobState(sourceId) {
  return {
    jobId: `dl_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`,
    phase: "selecting", // selecting|transferring|cancelling|completed|cancelled|failed
    running: true,
    source: sourceId,
    sourceOrder: [],    // 故障转移顺序(源 id 数组;auto=测速排序结果,手选=首选+其余后备)
    probe: null,        // auto 测速明细 [{id,label,mbps,error}](advisory,绝不作准入)
    filesTotal: 0,
    filesDone: 0,
    currentFile: "",
    doneBytes: 0,
    totalBytes: 0,
    resumeBytes: 0,     // 当前文件 .part 续传起点(每次尝试更新;取消/失败后即下次续传位置)
    retries: 0,
    skipped: 0,
    speedBps: 0,
    etaS: null,
    note: "",
    error: null,
    finished: false,
    terminalReason: null, // completed→null / cancelled→"cancelled" / failed→错误信息
  };
}

/**
 * 终态收束(后台任务 finally 单点调用;此时所有在途 list/probe/transfer 已 settle)。
 * @param {{ aborted: boolean, finished: boolean, errorMessage?: string|null }} outcome
 * @returns {{ phase: string, terminalReason: string|null, error: string|null, note?: string, finished: boolean, running: boolean }}
 */
export function finalizeDownloadJobState({ aborted, finished, errorMessage }) {
  if (aborted) {
    // 取消不是 error:.part 保留、已验证目标文件不删,下次同源/换源均可续传
    return {
      phase: "cancelled", terminalReason: "cancelled", error: null,
      note: "已取消，已下载部分已保留，下次继续", finished: false, running: false,
    };
  }
  if (finished) return { phase: "completed", terminalReason: null, error: null, finished: true, running: false };
  const msg = errorMessage || "下载失败(原因未记录)";
  return { phase: "failed", terminalReason: msg, error: msg, finished: false, running: false };
}

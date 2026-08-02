/**
 * search-tools.mjs -- 文件内容搜索 + 文件名搜索工具（search_files / search_by_name）
 *
 * 首次 cursor=0 执行实际搜索并建立短期只读快照；后续 cursor>0 只从同一快照翻页。
 * ripgrep 路径增量解析 stdout，达到全局快照上限即停止子进程；不可用或失败时显式回退 Node。
 */
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { Worker } from "node:worker_threads";
import { channel } from "node:diagnostics_channel";
import {
  resolveWorkspacePath,
  getWorkspaceRoot,
  identifierFuzzyPattern,
  ideOpLog,
  SKIP_DIRS,
} from "../infra.mjs";
import {
  MAX_SEARCH_FILE_SIZE,
} from "../constants.mjs";

const SEARCH_RUNTIME_DEFAULTS = Object.freeze({
  search_default_page_size: 50,
  search_max_page_size: 200,
  search_snapshot_ttl_ms: 120000,
  search_max_snapshot_results: 2000,
  search_timeout_ms: 10000,
  search_snapshot_cache_max_entries: 32,
  search_snapshot_cache_max_results: 20000,
});

const _snapshots = new Map();
const _isolatedOwnerKeys = new WeakMap();
let _expiryTimer = null;

function _boundedInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function _searchRuntime(params = {}, context = {}) {
  const contextPolicy = context && context.runtimePolicy && typeof context.runtimePolicy === "object"
    ? context.runtimePolicy
    : null;
  const source = contextPolicy && Object.keys(contextPolicy).length > 0
    ? contextPolicy
    : params._beiluRuntime && typeof params._beiluRuntime === "object"
      ? params._beiluRuntime
    : {};
  const maxPageSize = _boundedInt(
    source.search_max_page_size,
    SEARCH_RUNTIME_DEFAULTS.search_max_page_size,
    10,
    2000,
  );
  const maxSnapshotResults = _boundedInt(
    source.search_max_snapshot_results,
    SEARCH_RUNTIME_DEFAULTS.search_max_snapshot_results,
    100,
    20000,
  );
  return {
    defaultPageSize: Math.min(
      _boundedInt(
        source.search_default_page_size,
        SEARCH_RUNTIME_DEFAULTS.search_default_page_size,
        10,
        500,
      ),
      maxPageSize,
    ),
    maxPageSize,
    snapshotTtlMs: _boundedInt(
      source.search_snapshot_ttl_ms,
      SEARCH_RUNTIME_DEFAULTS.search_snapshot_ttl_ms,
      10000,
      3600000,
    ),
    maxSnapshotResults,
    timeoutMs: _boundedInt(
      source.search_timeout_ms,
      SEARCH_RUNTIME_DEFAULTS.search_timeout_ms,
      1000,
      120000,
    ),
    maxCachedSnapshots: _boundedInt(
      source.search_snapshot_cache_max_entries,
      SEARCH_RUNTIME_DEFAULTS.search_snapshot_cache_max_entries,
      4,
      512,
    ),
    maxCachedResults: Math.max(
      maxSnapshotResults,
      _boundedInt(
        source.search_snapshot_cache_max_results,
        SEARCH_RUNTIME_DEFAULTS.search_snapshot_cache_max_results,
        100,
        500000,
      ),
    ),
  };
}

function _ownerKey(params, context) {
  const owner = context && typeof context === "object" ? context.owner : null;
  const identity = [];
  if (typeof owner === "string" && owner.trim()) {
    identity.push(["owner", owner.trim()]);
  } else if (owner && typeof owner === "object") {
    for (const key of ["username", "userId", "chatid", "connectionId"]) {
      const value = owner[key];
      if (typeof value === "string" && value.trim()) identity.push([key, value.trim()]);
    }
  }
  if (context && typeof context === "object") {
    for (const key of ["username", "userId", "chatid", "connectionId"]) {
      const value = context[key];
      if (typeof value === "string" && value.trim()) identity.push([key, value.trim()]);
    }
  }
  if (identity.length > 0) {
    return `owner:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
  }

  // 没有可信 owner 时只允许同一调用上下文对象复用，不能退化成模块级公共 owner。
  const anchor = context && typeof context === "object"
    ? context
    : params && typeof params === "object"
      ? params
      : null;
  if (!anchor) return `isolated:${randomUUID()}`;
  let key = _isolatedOwnerKeys.get(anchor);
  if (!key) {
    key = `isolated:${randomUUID()}`;
    _isolatedOwnerKeys.set(anchor, key);
  }
  return key;
}

function _pageSize(params, runtime) {
  const requested = Number(params.maxResults);
  return Math.min(
    Number.isFinite(requested) && requested > 0
      ? Math.round(requested)
      : runtime.defaultPageSize,
    runtime.maxPageSize,
  );
}

function _cursor(params) {
  return Math.max(0, _boundedInt(params.cursor, 0, 0, Number.MAX_SAFE_INTEGER));
}

function _queryKey(spec) {
  return createHash("sha256")
    .update(JSON.stringify(spec))
    .digest("hex");
}

function _deleteSnapshot(searchId, reschedule = true) {
  _snapshots.delete(searchId);
  if (reschedule) _scheduleExpiryCleanup();
}

function _cleanupExpiredSnapshots(now = Date.now()) {
  for (const [searchId, snapshot] of _snapshots) {
    if (snapshot.expiresAt <= now) _deleteSnapshot(searchId, false);
  }
}

function _scheduleExpiryCleanup() {
  if (_expiryTimer) {
    clearTimeout(_expiryTimer);
    _expiryTimer = null;
  }
  let nearest = Infinity;
  for (const snapshot of _snapshots.values()) {
    nearest = Math.min(nearest, snapshot.expiresAt);
  }
  if (!Number.isFinite(nearest)) return;
  _expiryTimer = setTimeout(() => {
    _expiryTimer = null;
    _cleanupExpiredSnapshots();
    _scheduleExpiryCleanup();
  }, Math.max(1, nearest - Date.now()));
  _expiryTimer.unref?.();
}

function _enforceSnapshotBudget(runtime, ownerKey) {
  _cleanupExpiredSnapshots();
  const totalResults = (owner = null) => {
    let total = 0;
    for (const snapshot of _snapshots.values()) {
      if (!owner || snapshot.ownerKey === owner) total += snapshot.records.length;
    }
    return total;
  };
  const countSnapshots = (owner = null) => {
    let total = 0;
    for (const snapshot of _snapshots.values()) {
      if (!owner || snapshot.ownerKey === owner) total++;
    }
    return total;
  };
  const evictOldest = (owner = null) => {
    let oldest = null;
    for (const snapshot of _snapshots.values()) {
      if (owner && snapshot.ownerKey !== owner) continue;
      if (!oldest || snapshot.lastAccessedAt < oldest.lastAccessedAt) oldest = snapshot;
    }
    if (oldest) _deleteSnapshot(oldest.searchId, false);
    return !!oldest;
  };

  // 用户策略先约束自己的快照，不能用较小预算驱逐其他 owner。
  while (
    countSnapshots(ownerKey) > runtime.maxCachedSnapshots
    || totalResults(ownerKey) > runtime.maxCachedResults
  ) {
    if (!evictOldest(ownerKey)) break;
  }

  // 进程全局仍有硬预算；由当前活跃策略的最大值决定，但绝不超过归一化上界。
  let globalMaxEntries = SEARCH_RUNTIME_DEFAULTS.search_snapshot_cache_max_entries;
  let globalMaxResults = SEARCH_RUNTIME_DEFAULTS.search_snapshot_cache_max_results;
  for (const snapshot of _snapshots.values()) {
    globalMaxEntries = Math.max(globalMaxEntries, snapshot.cacheMaxEntries);
    globalMaxResults = Math.max(globalMaxResults, snapshot.cacheMaxResults);
  }
  while (
    countSnapshots() > globalMaxEntries
    || totalResults() > globalMaxResults
  ) {
    if (!evictOldest()) break;
  }
  _scheduleExpiryCleanup();
}

function _storeSnapshot({
  queryKey,
  workspaceRoot,
  tool,
  meta,
  records,
  engine,
  complete,
  fallbackReason,
  rangeLimitReason,
  workerReason,
  runtime,
  ownerKey,
}) {
  _cleanupExpiredSnapshots();
  const createdAt = Date.now();
  const snapshot = {
    searchId: randomUUID(),
    queryKey,
    workspaceRoot,
    tool,
    meta,
    records: Object.freeze(records.map((record) => Object.freeze({ ...record }))),
    engine,
    complete,
    fallbackReason: fallbackReason || null,
    rangeLimitReason: rangeLimitReason || null,
    workerReason: workerReason || null,
    ownerKey,
    cacheMaxEntries: runtime.maxCachedSnapshots,
    cacheMaxResults: runtime.maxCachedResults,
    snapshotAt: new Date(createdAt).toISOString(),
    expiresAt: createdAt + runtime.snapshotTtlMs,
    lastAccessedAt: createdAt,
  };
  _snapshots.set(snapshot.searchId, snapshot);
  _enforceSnapshotBudget(runtime, ownerKey);
  return snapshot;
}

function _reuseSnapshot(params, queryKey, workspaceRoot, tool, cursor, ownerKey) {
  const explicitId = typeof params.searchId === "string" && params.searchId.trim()
    ? params.searchId.trim()
    : null;
  if (!explicitId) {
    throw new Error(`searchIdRequired: cursor=${cursor} 的后续页必须携带首页返回的 searchId`);
  }
  const snapshot = _snapshots.get(explicitId);
  if (!snapshot) {
    throw new Error(`snapshotExpired: 搜索快照不存在或已过期: ${explicitId}`);
  }
  if (snapshot.expiresAt <= Date.now()) {
    _deleteSnapshot(explicitId);
    throw new Error(`snapshotExpired: 搜索快照已过期: ${explicitId}`);
  }
  if (snapshot.ownerKey !== ownerKey) {
    throw new Error(`searchSnapshotOwnerMismatch: 搜索快照不属于当前调用方: ${explicitId}`);
  }
  if (snapshot.workspaceRoot !== workspaceRoot) {
    throw new Error("snapshotExpired: 工作区根目录已变化，请从 cursor=0 重新搜索");
  }
  if (snapshot.tool !== tool || snapshot.queryKey !== queryKey) {
    throw new Error(`searchIdQueryMismatch: 搜索快照与当前查询不匹配: ${explicitId}`);
  }
  snapshot.lastAccessedAt = Date.now();
  return snapshot;
}

function _paginateSnapshot(snapshot, cursor, pageSize) {
  const page = snapshot.records
    .slice(cursor, cursor + pageSize)
    .map((record) => ({ ...record }));
  const hasMore = cursor + page.length < snapshot.records.length;
  const base = {
    ...snapshot.meta,
    total: page.length,
    truncated: hasMore || !snapshot.complete,
    nextCursor: hasMore ? cursor + page.length : null,
    searchId: snapshot.searchId,
    queryKey: snapshot.queryKey,
    snapshotAt: snapshot.snapshotAt,
    complete: snapshot.complete,
    snapshotCount: snapshot.records.length,
    pageCount: page.length,
    engine: snapshot.engine,
  };
  if (snapshot.fallbackReason) base.fallbackReason = snapshot.fallbackReason;
  if (snapshot.rangeLimitReason) base.rangeLimitReason = snapshot.rangeLimitReason;
  if (snapshot.workerReason) base.workerReason = snapshot.workerReason;
  if (snapshot.tool === "search_files") {
    const chars = page.reduce(
      (sum, match) => sum + (match.content || "").length + (match.context || "").length,
      0,
    );
    return {
      ...base,
      matches: page,
      budgetHint: chars > 8000
        ? `本页约 ${Math.round(chars / 1000)}k 字符偏大：建议缩小 pattern 或加 filePattern`
        : undefined,
    };
  }
  return { ...base, results: page };
}

/** 按文件 mtime 批量取修改时间。 */
function _metadataRangeReason(workerReason) {
  const suffix = String(workerReason || "node_worker_error").replace(/^node_/, "");
  return `ripgrep_metadata_${suffix}`;
}

function _sortContentStable(matches, mtimes = null) {
  matches.sort((a, b) => {
    const aMtime = mtimes?.get(a.file) ?? 0;
    const bMtime = mtimes?.get(b.file) ?? 0;
    if (bMtime !== aMtime) return bMtime - aMtime;
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    return a.line - b.line;
  });
}

/**
 * ripgrep 的 stdout 解析留在主线程；会触碰文件系统的 metadata 补全与排序交给
 * 既有可取消 worker。worker 异常时保留稳定的部分结果，并显式标记不完整。
 */
async function _enrichRipgrepContent(matches, wsRoot, deadline, signal, complete) {
  if (matches.length === 0) return { ok: true, records: matches, complete };
  const paths = [...new Set(matches.map((match) => match.file))]
    .map((file) => ({ path: file }));
  const metadata = await _searchWithNodeWorker({
    jobId: randomUUID(),
    kind: "content_metadata",
    records: paths,
    absPath: wsRoot,
    pattern: "",
    maxResults: Math.max(1, paths.length),
    wsRoot,
    deadlineEpochMs: deadline,
    maxFileSize: 0,
    skipDirs: [],
  }, signal);
  if (metadata.workerReason === "node_cancelled") {
    return _rgFailure("ripgrep_cancelled", "", false);
  }
  if (metadata.workerReason === "node_completed") {
    const mtimes = new Map(
      metadata.records.map((item) => [item.path, Number(item.mtime) || 0]),
    );
    _sortContentStable(matches, mtimes);
    return { ok: true, records: matches, complete };
  }
  _sortContentStable(matches);
  return {
    ok: true,
    records: matches,
    complete: false,
    rangeLimitReason: _metadataRangeReason(metadata.workerReason),
    workerReason: metadata.workerReason,
  };
}

async function _enrichRipgrepNames(results, wsRoot, deadline, signal, complete) {
  if (results.length === 0) return { ok: true, records: results, complete };
  const metadata = await _searchWithNodeWorker({
    jobId: randomUUID(),
    kind: "name_metadata",
    records: results.map((item) => ({ path: item.path })),
    absPath: wsRoot,
    pattern: "",
    maxResults: Math.max(1, results.length),
    wsRoot,
    deadlineEpochMs: deadline,
    maxFileSize: 0,
    skipDirs: [],
  }, signal);
  if (metadata.workerReason === "node_cancelled") {
    return _rgFailure("ripgrep_cancelled", "", false);
  }
  if (metadata.workerReason === "node_completed") {
    return { ok: true, records: metadata.records, complete };
  }
  for (const item of results) {
    item.size = 0;
    item.mtime = 0;
  }
  results.sort((a, b) => a.path.localeCompare(b.path));
  return {
    ok: true,
    records: results,
    complete: false,
    rangeLimitReason: _metadataRangeReason(metadata.workerReason),
    workerReason: metadata.workerReason,
  };
}

function _remainingMs(deadline) {
  return Math.max(0, deadline - Date.now());
}

function _appendReason(existing, reason) {
  if (!existing) return reason;
  return existing.split(";").includes(reason) ? existing : `${existing};${reason}`;
}

function _rgFailure(reason, stderr = "", fallbackAllowed = true) {
  const detail = String(stderr || "").trim().slice(0, 500);
  return {
    ok: false,
    reason: detail ? `${reason}:${detail}` : reason,
    fallbackAllowed,
  };
}

/** ripgrep JSON stdout 增量解析；不保留完整 stdout。 */
async function _searchWithRipgrep(
  pattern,
  searchDir,
  filePattern,
  maxResults,
  wsRoot,
  ignoreCase,
  deadline,
  signal,
) {
  return new Promise((resolve) => {
    const rgId = randomUUID();
    const remaining = _remainingMs(deadline);
    if (remaining <= 0) {
      resolve(_rgFailure("ripgrep_deadline_exhausted"));
      return;
    }
    if (signal?.aborted) {
      resolve(_rgFailure("ripgrep_cancelled", "", false));
      return;
    }
    const args = [
      "--no-config",
      "--json",
      "--hidden",
      "--glob=!.git/*",
      "--no-messages",
      "--no-heading",
    ];
    if (ignoreCase) args.push("-i");
    if (filePattern && filePattern !== "*") args.push("--glob", filePattern);
    args.push("-e", pattern, searchDir);

    const env = { ...process.env };
    delete env.RIPGREP_CONFIG_PATH;

    let child;
    try {
      child = cp.spawn("rg", args, {
        windowsHide: true,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve(_rgFailure("ripgrep_spawn_failed", error?.message));
      return;
    }
    _publishRipgrepLifecycle(rgId, "content", "started");

    const matches = [];
    const decoder = new StringDecoder("utf8");
    let remainder = "";
    let stderr = "";
    let settled = false;
    let hitLimit = false;
    let parseFailed = false;
    let timedOut = false;
    let stopRequested = false;
    let stopReason = null;
    let stopFallbackAllowed = true;
    let forceTimer = null;
    let orphanTimer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      if (orphanTimer) clearTimeout(orphanTimer);
      signal?.removeEventListener("abort", onAbort);
      _publishRipgrepLifecycle(rgId, "content", "settled", {
        ok: result?.ok === true,
        reason: result?.reason,
      });
      resolve(result);
    };
    const requestStop = (reason, fallbackAllowed = true) => {
      if (stopRequested || settled) return;
      stopRequested = true;
      stopReason = reason;
      stopFallbackAllowed = fallbackAllowed;
      _publishRipgrepLifecycle(rgId, "content", "stop_requested", { reason });
      try { child.stdout.pause(); } catch { /* stdout may already be closed */ }
      try { child.kill(); } catch { /* process may already have exited */ }
      forceTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* process may already have exited */ }
        orphanTimer = setTimeout(() => {
          finish(_rgFailure(`${reason}_close_timeout`, stderr, false));
        }, 250);
        orphanTimer.unref?.();
      }, 250);
      forceTimer.unref?.();
    };
    const onAbort = () => requestStop("ripgrep_cancelled", false);
    const consumeLine = (line) => {
      if (!line || settled || stopRequested || hitLimit || parseFailed) return;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        parseFailed = true;
        requestStop("ripgrep_parse_error");
        return;
      }
      if (obj.type !== "match" || !obj.data) return;
      const absoluteFile = path.isAbsolute(obj.data.path.text)
        ? obj.data.path.text
        : path.resolve(searchDir, obj.data.path.text);
      const relPath = path.relative(wsRoot, absoluteFile).replace(/\\/g, "/");
      const raw = (obj.data.lines?.text || "").replace(/\r?\n$/, "");
      matches.push({
        file: relPath,
        line: obj.data.line_number,
        content: raw.trim(),
        context: raw,
      });
      if (matches.length >= maxResults) {
        hitLimit = true;
        requestStop("ripgrep_result_limit");
      }
    };

    child.stdout.on("data", (chunk) => {
      if (settled) return;
      remainder += decoder.write(chunk);
      let newline;
      while ((newline = remainder.indexOf("\n")) >= 0) {
        const line = remainder.slice(0, newline).replace(/\r$/, "");
        remainder = remainder.slice(newline + 1);
        consumeLine(line);
        if (stopRequested) break;
      }
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 2000) stderr += chunk.toString("utf-8");
    });
    child.on("error", (error) => {
      stopReason = "ripgrep_unavailable";
      _publishRipgrepLifecycle(rgId, "content", "error");
      if (error?.message && stderr.length < 2000) stderr += error.message;
    });
    child.on("close", async (code) => {
      if (settled) return;
      _publishRipgrepLifecycle(rgId, "content", "close", { code });
      if (forceTimer) clearTimeout(forceTimer);
      if (orphanTimer) clearTimeout(orphanTimer);
      if (stopReason === "ripgrep_result_limit") {
        finish(await _enrichRipgrepContent(matches, wsRoot, deadline, signal, false));
        return;
      }
      if (stopReason) {
        finish(_rgFailure(stopReason, stderr, stopFallbackAllowed));
        return;
      }
      remainder += decoder.end();
      if (!hitLimit && !parseFailed && remainder) consumeLine(remainder.replace(/\r$/, ""));
      if (parseFailed) {
        finish(_rgFailure("ripgrep_parse_error", stderr));
        return;
      }
      if (timedOut) {
        finish(_rgFailure("ripgrep_timeout", stderr));
        return;
      }
      if (!hitLimit && (code === null || code > 1)) {
        finish(_rgFailure(`ripgrep_exit_${code}`, stderr));
        return;
      }
      finish(await _enrichRipgrepContent(matches, wsRoot, deadline, signal, !hitLimit));
    });

    const timer = setTimeout(() => {
      timedOut = true;
      requestStop("ripgrep_timeout");
    }, remaining);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** ripgrep --files stdout 增量解析；达到快照上限即停止。 */
async function _searchByNameWithRipgrep(
  pattern,
  searchDir,
  maxResults,
  wsRoot,
  deadline,
  signal,
) {
  return new Promise((resolve) => {
    const rgId = randomUUID();
    const remaining = _remainingMs(deadline);
    if (remaining <= 0) {
      resolve(_rgFailure("ripgrep_deadline_exhausted"));
      return;
    }
    if (signal?.aborted) {
      resolve(_rgFailure("ripgrep_cancelled", "", false));
      return;
    }
    const args = [
      "--no-config",
      "--files",
      "--hidden",
      "--glob=!.git/*",
      "--no-messages",
    ];
    if (pattern && pattern !== "*") args.push("--glob", pattern);
    args.push(searchDir);

    const env = { ...process.env };
    delete env.RIPGREP_CONFIG_PATH;

    let child;
    try {
      child = cp.spawn("rg", args, {
        windowsHide: true,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve(_rgFailure("ripgrep_spawn_failed", error?.message));
      return;
    }
    _publishRipgrepLifecycle(rgId, "name", "started");

    const results = [];
    const decoder = new StringDecoder("utf8");
    let remainder = "";
    let stderr = "";
    let settled = false;
    let hitLimit = false;
    let timedOut = false;
    let stopRequested = false;
    let stopReason = null;
    let stopFallbackAllowed = true;
    let forceTimer = null;
    let orphanTimer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      if (orphanTimer) clearTimeout(orphanTimer);
      signal?.removeEventListener("abort", onAbort);
      _publishRipgrepLifecycle(rgId, "name", "settled", {
        ok: result?.ok === true,
        reason: result?.reason,
      });
      resolve(result);
    };
    const requestStop = (reason, fallbackAllowed = true) => {
      if (stopRequested || settled) return;
      stopRequested = true;
      stopReason = reason;
      stopFallbackAllowed = fallbackAllowed;
      _publishRipgrepLifecycle(rgId, "name", "stop_requested", { reason });
      try { child.stdout.pause(); } catch { /* stdout may already be closed */ }
      try { child.kill(); } catch { /* process may already have exited */ }
      forceTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* process may already have exited */ }
        orphanTimer = setTimeout(() => {
          finish(_rgFailure(`${reason}_close_timeout`, stderr, false));
        }, 250);
        orphanTimer.unref?.();
      }, 250);
      forceTimer.unref?.();
    };
    const onAbort = () => requestStop("ripgrep_cancelled", false);
    const consumePath = (rawPath) => {
      if (!rawPath || settled || stopRequested || hitLimit) return;
      const absoluteFile = path.isAbsolute(rawPath)
        ? rawPath
        : path.resolve(searchDir, rawPath);
      results.push({
        name: path.basename(absoluteFile),
        path: path.relative(wsRoot, absoluteFile).replace(/\\/g, "/"),
        size: 0,
        mtime: 0,
      });
      if (results.length >= maxResults) {
        hitLimit = true;
        requestStop("ripgrep_result_limit");
      }
    };

    child.stdout.on("data", (chunk) => {
      if (settled) return;
      remainder += decoder.write(chunk);
      let newline;
      while ((newline = remainder.indexOf("\n")) >= 0) {
        const line = remainder.slice(0, newline).replace(/\r$/, "");
        remainder = remainder.slice(newline + 1);
        consumePath(line);
        if (stopRequested) break;
      }
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 2000) stderr += chunk.toString("utf-8");
    });
    child.on("error", (error) => {
      stopReason = "ripgrep_unavailable";
      _publishRipgrepLifecycle(rgId, "name", "error");
      if (error?.message && stderr.length < 2000) stderr += error.message;
    });
    child.on("close", async (code) => {
      if (settled) return;
      _publishRipgrepLifecycle(rgId, "name", "close", { code });
      if (forceTimer) clearTimeout(forceTimer);
      if (orphanTimer) clearTimeout(orphanTimer);
      if (stopReason === "ripgrep_result_limit") {
        finish(await _enrichRipgrepNames(results, wsRoot, deadline, signal, false));
        return;
      }
      if (stopReason) {
        finish(_rgFailure(stopReason, stderr, stopFallbackAllowed));
        return;
      }
      remainder += decoder.end();
      if (!hitLimit && remainder) consumePath(remainder.replace(/\r$/, ""));
      if (timedOut) {
        finish(_rgFailure("ripgrep_timeout", stderr));
        return;
      }
      if (!hitLimit && (code === null || code > 1)) {
        finish(_rgFailure(`ripgrep_exit_${code}`, stderr));
        return;
      }
      finish(await _enrichRipgrepNames(results, wsRoot, deadline, signal, !hitLimit));
    });

    const timer = setTimeout(() => {
      timedOut = true;
      requestStop("ripgrep_timeout");
    }, remaining);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const NODE_SEARCH_WORKER_URL = new URL("./node-search-worker.mjs", import.meta.url);
const NODE_SEARCH_LIFECYCLE = channel("beilu.node-search-worker");
const RIPGREP_SEARCH_LIFECYCLE = channel("beilu.ripgrep-search");

function _publishWorkerLifecycle(jobId, event, detail = {}) {
  try {
    NODE_SEARCH_LIFECYCLE.publish({
      backend: "cli",
      jobId,
      event,
      at: Date.now(),
      ...detail,
    });
  } catch { /* diagnostics subscriber must not affect execution */ }
}

function _publishRipgrepLifecycle(rgId, kind, event, detail = {}) {
  try {
    RIPGREP_SEARCH_LIFECYCLE.publish({
      backend: "cli",
      rgId,
      kind,
      event,
      at: Date.now(),
      ...detail,
    });
  } catch { /* diagnostics subscriber must not affect execution */ }
}

/**
 * worker 结果只在 exit 后结算。deadline 与外部 WS lifecycle 都进入同一个
 * AbortController；取消路径先发 cancel，再 terminate，并等待 terminate/exit。
 */
async function _searchWithNodeWorker(job, externalSignal) {
  const remaining = _remainingMs(job.deadlineEpochMs);
  if (remaining <= 0) {
    return {
      records: [],
      complete: false,
      workerReason: "node_timeout",
    };
  }
  if (externalSignal?.aborted) {
    return {
      records: [],
      complete: false,
      workerReason: "node_cancelled",
    };
  }

  let worker;
  try {
    _publishWorkerLifecycle(job.jobId, "start_attempt");
    worker = new Worker(NODE_SEARCH_WORKER_URL, { workerData: job });
    _publishWorkerLifecycle(job.jobId, "started");
  } catch {
    _publishWorkerLifecycle(job.jobId, "start_failed");
    return {
      records: [],
      complete: false,
      workerReason: "node_worker_start_failed",
    };
  }

  return new Promise((resolve) => {
    const controller = new AbortController();
    let workerResult = null;
    let workerError = false;
    let cancelling = false;
    let settled = false;
    let exitCode = null;
    let deadlineTimer = null;
    let resolveExit;
    const exitPromise = new Promise((exitResolve) => {
      resolveExit = exitResolve;
    });

    const cleanup = () => {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      externalSignal?.removeEventListener("abort", onExternalAbort);
      controller.signal.removeEventListener("abort", onAbort);
      worker.removeAllListeners("message");
      worker.removeAllListeners("error");
      worker.removeAllListeners("exit");
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      _publishWorkerLifecycle(job.jobId, "settled", { reason: result.workerReason });
      cleanup();
      resolve(result);
    };
    const cancelWorker = async (reason) => {
      if (cancelling || settled) return;
      cancelling = true;
      _publishWorkerLifecycle(job.jobId, "cancel_requested", { reason });
      try { worker.postMessage({ type: "cancel", jobId: job.jobId }); } catch { /* worker may already exit */ }
      try {
        await worker.terminate();
        await exitPromise;
      } catch {
        await exitPromise;
      }
      _publishWorkerLifecycle(job.jobId, "terminated", { reason, exitCode });
      finish({
        records: [],
        complete: false,
        workerReason: reason,
      });
    };
    const onAbort = () => {
      const reason = controller.signal.reason === "node_timeout"
        ? "node_timeout"
        : "node_cancelled";
      void cancelWorker(reason);
    };
    const onExternalAbort = () => {
      if (!controller.signal.aborted) controller.abort("node_cancelled");
    };

    worker.on("message", (message) => {
      if (
        settled
        || cancelling
        || !message
        || message.type !== "result"
        || message.jobId !== job.jobId
      ) {
        return;
      }
      workerResult = message;
      _publishWorkerLifecycle(job.jobId, "message", { reason: message.workerReason });
    });
    worker.on("error", () => {
      workerError = true;
      _publishWorkerLifecycle(job.jobId, "error");
    });
    worker.once("exit", (code) => {
      exitCode = code;
      _publishWorkerLifecycle(job.jobId, "exit", { code });
      resolveExit(code);
      if (cancelling || settled) return;
      if (workerError) {
        finish({ records: [], complete: false, workerReason: "node_worker_error" });
        return;
      }
      if (!workerResult) {
        finish({
          records: [],
          complete: false,
          workerReason: code === 0 ? "node_worker_no_result" : `node_worker_exit_${code}`,
        });
        return;
      }
      if (workerResult.errorCode === "invalid_regex") {
        finish({
          records: [],
          complete: false,
          workerReason: workerResult.workerReason || "node_invalid_regex",
          errorCode: "invalid_regex",
          errorMessage: workerResult.errorMessage,
        });
        return;
      }
      finish({
        records: Array.isArray(workerResult.records) ? workerResult.records : [],
        complete: workerResult.complete === true,
        workerReason: workerResult.workerReason || (exitCode === 0 ? "node_completed" : `node_worker_exit_${exitCode}`),
        rangeLimitReason: workerResult.rangeLimitReason,
      });
    });

    deadlineTimer = setTimeout(() => {
      if (!controller.signal.aborted) controller.abort("node_timeout");
    }, _remainingMs(job.deadlineEpochMs));
    deadlineTimer.unref?.();
    controller.signal.addEventListener("abort", onAbort, { once: true });
    externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
    if (externalSignal?.aborted) onExternalAbort();
  });
}

function _throwIfCancelled(signal) {
  if (!signal?.aborted) return;
  const error = new Error("node_cancelled: 搜索调用已由连接生命周期取消");
  error.name = "AbortError";
  throw error;
}

async function _targetStat(absPath, displayPath) {
  try {
    return await fs.promises.stat(absPath);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`路径不存在: ${displayPath}`);
    throw error;
  }
}

/** 搜索文件内容（正则匹配）：首次搜索建快照，后续稳定翻页。 */
export async function searchFiles(params, context = null) {
  let pattern = params.pattern || params.query;
  if (!pattern) throw new Error("缺少 pattern 参数（也接受 query）");

  const searchPath = params.path || ".";
  const filePattern = params.filePattern || "*";
  const fuzzyIdentifier = !!(
    params.fuzzyIdentifier
    ?? params.identifier_fuzzy
    ?? params.fuzzy_identifier
  );
  if (fuzzyIdentifier) pattern = identifierFuzzyPattern(pattern);
  const ignoreCase = !!(params.ignoreCase ?? params.ignore_case);
  const absPath = resolveWorkspacePath(searchPath);

  const wsRoot = getWorkspaceRoot();
  const workspaceRoot = path.resolve(wsRoot).replace(/\\/g, "/");
  const runtime = _searchRuntime(params, context);
  const ownerKey = _ownerKey(params, context);
  const cursor = _cursor(params);
  const pageSize = _pageSize(params, runtime);
  const queryKey = _queryKey({
    kind: "content",
    pattern,
    path: path.resolve(absPath).replace(/\\/g, "/"),
    filePattern,
    ignoreCase,
    workspaceRoot,
  });

  let snapshot;
  if (cursor > 0) {
    snapshot = _reuseSnapshot(
      params,
      queryKey,
      workspaceRoot,
      "search_files",
      cursor,
      ownerKey,
    );
  } else {
    const deadline = Date.now() + runtime.timeoutMs;
    const signal = context && typeof context === "object" ? context.signal : null;
    const targetStat = await _targetStat(absPath, searchPath);
    _throwIfCancelled(signal);
    let records;
    let engine;
    let complete;
    let fallbackReason = null;
    let rangeLimitReason = null;
    let workerReason = null;

    if (!targetStat.isFile()) {
      const rgResult = await _searchWithRipgrep(
        pattern,
        absPath,
        filePattern,
        runtime.maxSnapshotResults,
        wsRoot,
        ignoreCase,
        deadline,
        signal,
      );
      _throwIfCancelled(signal);
      if (rgResult.ok) {
        ({ records, complete } = rgResult);
        engine = "ripgrep";
        rangeLimitReason = rgResult.rangeLimitReason || null;
        workerReason = rgResult.workerReason || null;
      } else {
        fallbackReason = rgResult.reason;
        if (rgResult.fallbackAllowed === false) {
          records = [];
          complete = false;
          engine = "ripgrep";
        }
      }
    } else {
      fallbackReason = "ripgrep_not_applicable_file_target";
    }

    if (!records && _remainingMs(deadline) > 0) {
      const nodeResult = await _searchWithNodeWorker({
        jobId: randomUUID(),
        kind: "content",
        pattern,
        absPath,
        filePattern,
        maxResults: runtime.maxSnapshotResults,
        wsRoot,
        ignoreCase,
        deadlineEpochMs: deadline,
        maxFileSize: MAX_SEARCH_FILE_SIZE,
        skipDirs: [...SKIP_DIRS],
      }, signal);
      _throwIfCancelled(signal);
      if (nodeResult.errorCode === "invalid_regex") {
        throw new Error(nodeResult.errorMessage || `无效的正则表达式: ${pattern}`);
      }
      records = nodeResult.records;
      complete = nodeResult.complete;
      engine = "node";
      workerReason = nodeResult.workerReason;
      if (!["node_completed", "node_result_limit"].includes(workerReason)) {
        fallbackReason = _appendReason(fallbackReason, workerReason);
      }
      rangeLimitReason = nodeResult.rangeLimitReason;
    } else if (!records) {
      records = [];
      complete = false;
      engine = targetStat.isFile() ? "node" : "ripgrep";
      fallbackReason = _appendReason(fallbackReason, "node_deadline_exhausted");
    }

    await new Promise((resolve) => setImmediate(resolve));
    _throwIfCancelled(signal);
    snapshot = _storeSnapshot({
      queryKey,
      workspaceRoot,
      tool: "search_files",
      meta: {
        pattern,
        directory: searchPath,
        filePattern,
      },
      records,
      engine,
      complete,
      fallbackReason,
      rangeLimitReason,
      workerReason,
      runtime,
      ownerKey,
    });
  }

  return _paginateSnapshot(snapshot, cursor, pageSize);
}

/** 按文件名搜索：首次搜索建快照，后续稳定翻页。 */
export async function searchByName(params, context = null) {
  const pattern = params.pattern;
  if (!pattern) throw new Error("缺少 pattern 参数");

  const searchPath = params.path || ".";
  const absPath = resolveWorkspacePath(searchPath);

  const wsRoot = getWorkspaceRoot();
  const workspaceRoot = path.resolve(wsRoot).replace(/\\/g, "/");
  const runtime = _searchRuntime(params, context);
  const ownerKey = _ownerKey(params, context);
  const cursor = _cursor(params);
  const pageSize = _pageSize(params, runtime);
  const namePattern = pattern.replace(/^(\*\*\/)+/, "") || pattern;
  const queryKey = _queryKey({
    kind: "name",
    pattern: namePattern,
    path: path.resolve(absPath).replace(/\\/g, "/"),
    workspaceRoot,
  });

  let snapshot;
  if (cursor > 0) {
    snapshot = _reuseSnapshot(
      params,
      queryKey,
      workspaceRoot,
      "search_by_name",
      cursor,
      ownerKey,
    );
  } else {
    const deadline = Date.now() + runtime.timeoutMs;
    const signal = context && typeof context === "object" ? context.signal : null;
    const targetStat = await _targetStat(absPath, searchPath);
    _throwIfCancelled(signal);
    let records;
    let engine;
    let complete;
    let fallbackReason = null;
    let rangeLimitReason = null;
    let workerReason = null;

    if (targetStat.isFile()) {
      fallbackReason = "ripgrep_not_applicable_file_target";
    } else {
      const rgResult = await _searchByNameWithRipgrep(
        namePattern,
        absPath,
        runtime.maxSnapshotResults,
        wsRoot,
        deadline,
        signal,
      );
      _throwIfCancelled(signal);
      if (rgResult.ok) {
        ({ records, complete } = rgResult);
        engine = "ripgrep";
        rangeLimitReason = rgResult.rangeLimitReason || null;
        workerReason = rgResult.workerReason || null;
      } else {
        fallbackReason = rgResult.reason;
        if (rgResult.fallbackAllowed === false) {
          records = [];
          complete = false;
          engine = "ripgrep";
        }
      }
    }

    if (!records && _remainingMs(deadline) > 0) {
      const nodeResult = await _searchWithNodeWorker({
        jobId: randomUUID(),
        kind: "name",
        pattern: namePattern,
        absPath,
        maxResults: runtime.maxSnapshotResults,
        wsRoot,
        deadlineEpochMs: deadline,
        maxFileSize: MAX_SEARCH_FILE_SIZE,
        skipDirs: [...SKIP_DIRS],
      }, signal);
      _throwIfCancelled(signal);
      records = nodeResult.records;
      complete = nodeResult.complete;
      engine = "node";
      workerReason = nodeResult.workerReason;
      if (!["node_completed", "node_result_limit"].includes(workerReason)) {
        fallbackReason = _appendReason(fallbackReason, workerReason);
      }
      rangeLimitReason = nodeResult.rangeLimitReason;
    } else if (!records) {
      records = [];
      complete = false;
      engine = targetStat.isFile() ? "node" : "ripgrep";
      fallbackReason = _appendReason(fallbackReason, "node_deadline_exhausted");
    }

    ideOpLog(
      "search_by_name",
      "debug",
      {
        absPath,
        pattern,
        namePattern,
        engine,
        count: records.length,
        complete,
      },
      "ok",
    );
    await new Promise((resolve) => setImmediate(resolve));
    _throwIfCancelled(signal);
    snapshot = _storeSnapshot({
      queryKey,
      workspaceRoot,
      tool: "search_by_name",
      meta: {
        pattern,
        directory: searchPath,
      },
      records,
      engine,
      complete,
      fallbackReason,
      rangeLimitReason,
      workerReason,
      runtime,
      ownerKey,
    });
  }

  return _paginateSnapshot(snapshot, cursor, pageSize);
}

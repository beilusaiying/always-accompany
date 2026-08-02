/**
 * search-tools.ts -- 文件内容搜索 + 文件名搜索工具（search_files / search_by_name）
 *
 * 搜索结果先形成带 TTL 的只读快照，再从快照分页。cursor=0 总是新建快照；
 * cursor>0 必须复用同 query 的现存快照，避免工作区变化导致后页漂移。
 */
import * as cp from "child_process";
import * as fs from "fs";
import * as path from "path";
import { createHash, randomUUID } from "crypto";
import { StringDecoder } from "string_decoder";
import { Worker } from "worker_threads";
import { channel } from "diagnostics_channel";
import {
  resolveWorkspacePath,
  getWorkspaceRoot,
  identifierFuzzyPattern,
  ideOpLog,
  SKIP_DIRS,
} from "../tool-infra";
import {
  MAX_SEARCH_FILE_SIZE,
} from "../../constants";

interface SearchRuntime {
  defaultPageSize: number;
  maxPageSize: number;
  snapshotTtlMs: number;
  maxSnapshotResults: number;
  timeoutMs: number;
  maxCachedSnapshots: number;
  maxCachedResults: number;
}

interface SearchCallContext {
  runtimePolicy?: Record<string, unknown>;
  owner?: string | {
    username?: string;
    userId?: string;
    chatid?: string;
    connectionId?: string;
  };
  username?: string;
  userId?: string;
  chatid?: string;
  connectionId?: string;
  signal?: AbortSignal;
}

interface ContentMatch {
  file: string;
  line: number;
  content: string;
  context: string;
}

interface NameMatch {
  name: string;
  path: string;
  size: number;
  mtime: number;
}

interface MetadataMatch {
  path: string;
  mtime: number;
  name?: string;
  size?: number;
}

type WorkerRecord = ContentMatch | NameMatch | MetadataMatch;
type SearchEngine = "ripgrep" | "node";
type SearchKind = "content" | "name";

interface SearchSnapshot<T extends ContentMatch | NameMatch> {
  searchId: string;
  queryKey: string;
  kind: SearchKind;
  workspaceRoot: string;
  snapshotAt: string;
  expiresAt: number;
  complete: boolean;
  engine: SearchEngine;
  fallbackReason?: string;
  rangeLimitReason?: string;
  workerReason?: string;
  ownerKey: string;
  lastAccessedAt: number;
  cacheMaxEntries: number;
  cacheMaxResults: number;
  items: T[];
}

interface CollectionResult<T extends WorkerRecord> {
  items: T[];
  complete: boolean;
  fallbackReason?: string;
  rangeLimitReason?: string;
  fallbackAllowed?: boolean;
  workerReason?: string;
}

const SEARCH_RUNTIME_DEFAULTS = Object.freeze({
  search_default_page_size: 50,
  search_max_page_size: 200,
  search_snapshot_ttl_ms: 120000,
  search_max_snapshot_results: 2000,
  search_timeout_ms: 10000,
  search_snapshot_cache_max_entries: 32,
  search_snapshot_cache_max_results: 20000,
});

const snapshots = new Map<string, SearchSnapshot<ContentMatch | NameMatch>>();
const isolatedOwnerKeys = new WeakMap<object, string>();
let expiryTimer: NodeJS.Timeout | undefined;

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.max(min, Math.min(max, Math.round(numberValue)));
}

function searchRuntime(
  params: Record<string, unknown>,
  context?: SearchCallContext,
): SearchRuntime {
  const contextPolicy = context?.runtimePolicy;
  const raw = contextPolicy && Object.keys(contextPolicy).length > 0
    ? contextPolicy
    : params._beiluRuntime;
  const runtime = raw && typeof raw === "object"
    ? raw as Record<string, unknown>
    : {};
  const maxPageSize = boundedInt(
    runtime.search_max_page_size,
    SEARCH_RUNTIME_DEFAULTS.search_max_page_size,
    10,
    2000,
  );
  const maxSnapshotResults = boundedInt(
    runtime.search_max_snapshot_results,
    SEARCH_RUNTIME_DEFAULTS.search_max_snapshot_results,
    100,
    20000,
  );
  return {
    defaultPageSize: Math.min(
      boundedInt(
        runtime.search_default_page_size,
        SEARCH_RUNTIME_DEFAULTS.search_default_page_size,
        10,
        500,
      ),
      maxPageSize,
    ),
    maxPageSize,
    snapshotTtlMs: boundedInt(
      runtime.search_snapshot_ttl_ms,
      SEARCH_RUNTIME_DEFAULTS.search_snapshot_ttl_ms,
      10000,
      3600000,
    ),
    maxSnapshotResults,
    timeoutMs: boundedInt(
      runtime.search_timeout_ms,
      SEARCH_RUNTIME_DEFAULTS.search_timeout_ms,
      1000,
      120000,
    ),
    maxCachedSnapshots: boundedInt(
      runtime.search_snapshot_cache_max_entries,
      SEARCH_RUNTIME_DEFAULTS.search_snapshot_cache_max_entries,
      4,
      512,
    ),
    maxCachedResults: Math.max(
      maxSnapshotResults,
      boundedInt(
        runtime.search_snapshot_cache_max_results,
        SEARCH_RUNTIME_DEFAULTS.search_snapshot_cache_max_results,
        100,
        500000,
      ),
    ),
  };
}

function ownerKey(
  params: Record<string, unknown>,
  context?: SearchCallContext,
): string {
  const identity: Array<[string, string]> = [];
  if (typeof context?.owner === "string" && context.owner.trim()) {
    identity.push(["owner", context.owner.trim()]);
  } else if (context?.owner && typeof context.owner === "object") {
    for (const key of ["username", "userId", "chatid", "connectionId"] as const) {
      const value = context.owner[key];
      if (typeof value === "string" && value.trim()) identity.push([key, value.trim()]);
    }
  }
  if (context) {
    for (const key of ["username", "userId", "chatid", "connectionId"] as const) {
      const value = context[key];
      if (typeof value === "string" && value.trim()) identity.push([key, value.trim()]);
    }
  }
  if (identity.length > 0) {
    return `owner:${createHash("sha256").update(JSON.stringify(identity), "utf8").digest("hex")}`;
  }
  const anchor = context && typeof context === "object" ? context : params;
  let isolated = isolatedOwnerKeys.get(anchor);
  if (!isolated) {
    isolated = `isolated:${randomUUID()}`;
    isolatedOwnerKeys.set(anchor, isolated);
  }
  return isolated;
}

function normalizeFsPath(value: string): string {
  return path.resolve(value).replace(/\\/g, "/");
}

function queryKey(value: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function removeSnapshot(
  snapshot: SearchSnapshot<ContentMatch | NameMatch>,
  reschedule = true,
): void {
  snapshots.delete(snapshot.searchId);
  if (reschedule) scheduleExpiryCleanup();
}

function purgeExpiredSnapshots(now = Date.now()): void {
  for (const snapshot of snapshots.values()) {
    if (snapshot.expiresAt <= now) removeSnapshot(snapshot, false);
  }
}

function scheduleExpiryCleanup(): void {
  if (expiryTimer) {
    clearTimeout(expiryTimer);
    expiryTimer = undefined;
  }
  let nearest = Infinity;
  for (const snapshot of snapshots.values()) {
    nearest = Math.min(nearest, snapshot.expiresAt);
  }
  if (!Number.isFinite(nearest)) return;
  expiryTimer = setTimeout(() => {
    expiryTimer = undefined;
    purgeExpiredSnapshots();
    scheduleExpiryCleanup();
  }, Math.max(1, nearest - Date.now()));
  expiryTimer.unref();
}

function enforceSnapshotBudget(runtime: SearchRuntime, ownerKey: string): void {
  purgeExpiredSnapshots();
  const totalResults = (owner?: string): number => {
    let total = 0;
    for (const snapshot of snapshots.values()) {
      if (!owner || snapshot.ownerKey === owner) total += snapshot.items.length;
    }
    return total;
  };
  const countSnapshots = (owner?: string): number => {
    let total = 0;
    for (const snapshot of snapshots.values()) {
      if (!owner || snapshot.ownerKey === owner) total++;
    }
    return total;
  };
  const evictOldest = (owner?: string): boolean => {
    let oldest: SearchSnapshot<ContentMatch | NameMatch> | undefined;
    for (const snapshot of snapshots.values()) {
      if (owner && snapshot.ownerKey !== owner) continue;
      if (!oldest || snapshot.lastAccessedAt < oldest.lastAccessedAt) oldest = snapshot;
    }
    if (oldest) removeSnapshot(oldest, false);
    return !!oldest;
  };

  while (
    countSnapshots(ownerKey) > runtime.maxCachedSnapshots
    || totalResults(ownerKey) > runtime.maxCachedResults
  ) {
    if (!evictOldest(ownerKey)) break;
  }

  let globalMaxEntries: number = SEARCH_RUNTIME_DEFAULTS.search_snapshot_cache_max_entries;
  let globalMaxResults: number = SEARCH_RUNTIME_DEFAULTS.search_snapshot_cache_max_results;
  for (const snapshot of snapshots.values()) {
    globalMaxEntries = Math.max(globalMaxEntries, snapshot.cacheMaxEntries);
    globalMaxResults = Math.max(globalMaxResults, snapshot.cacheMaxResults);
  }
  while (
    countSnapshots() > globalMaxEntries
    || totalResults() > globalMaxResults
  ) {
    if (!evictOldest()) break;
  }
  scheduleExpiryCleanup();
}

function createSnapshot<T extends ContentMatch | NameMatch>(
  kind: SearchKind,
  key: string,
  workspaceRoot: string,
  runtime: SearchRuntime,
  engine: SearchEngine,
  collection: CollectionResult<T>,
  owner: string,
): SearchSnapshot<T> {
  purgeExpiredSnapshots();
  const snapshotAt = new Date().toISOString();
  const snapshot: SearchSnapshot<T> = {
    searchId: randomUUID(),
    queryKey: key,
    kind,
    workspaceRoot,
    snapshotAt,
    expiresAt: Date.now() + runtime.snapshotTtlMs,
    complete: collection.complete,
    engine,
    ...(collection.fallbackReason ? { fallbackReason: collection.fallbackReason } : {}),
    ...(collection.rangeLimitReason ? { rangeLimitReason: collection.rangeLimitReason } : {}),
    ...(collection.workerReason ? { workerReason: collection.workerReason } : {}),
    ownerKey: owner,
    lastAccessedAt: Date.now(),
    cacheMaxEntries: runtime.maxCachedSnapshots,
    cacheMaxResults: runtime.maxCachedResults,
    items: Object.freeze(collection.items.slice()) as unknown as T[],
  };
  snapshots.set(snapshot.searchId, snapshot);
  enforceSnapshotBudget(runtime, owner);
  return snapshot;
}

function getSnapshot<T extends ContentMatch | NameMatch>(
  kind: SearchKind,
  key: string,
  workspaceRoot: string,
  explicitSearchId: string | undefined,
  owner: string,
): SearchSnapshot<T> {
  purgeExpiredSnapshots();
  if (!explicitSearchId) {
    throw new Error("searchIdRequired: 后续页必须携带首页返回的 searchId");
  }
  const snapshot = snapshots.get(explicitSearchId);
  if (!snapshot) {
    throw new Error(`snapshotExpired: 搜索快照 ${explicitSearchId} 不存在或已过期，请从 cursor=0 重新搜索`);
  }
  if (snapshot.expiresAt <= Date.now()) {
    removeSnapshot(snapshot);
    throw new Error(`snapshotExpired: 搜索快照 ${explicitSearchId} 不存在或已过期，请从 cursor=0 重新搜索`);
  }
  if (snapshot.ownerKey !== owner) {
    throw new Error(`searchSnapshotOwnerMismatch: 搜索快照不属于当前调用方: ${explicitSearchId}`);
  }
  if (snapshot.workspaceRoot !== workspaceRoot) {
    throw new Error("snapshotExpired: 工作区根目录已变化，请从 cursor=0 重新搜索");
  }
  if (snapshot.kind !== kind || snapshot.queryKey !== key) {
    throw new Error(`searchIdQueryMismatch: 搜索快照 ${explicitSearchId} 与当前查询不匹配`);
  }
  snapshot.lastAccessedAt = Date.now();
  return snapshot as SearchSnapshot<T>;
}

function appendReason(existing: string | undefined, reason: string): string {
  if (!existing) return reason;
  return existing.split(";").includes(reason) ? existing : `${existing};${reason}`;
}

function remainingMs(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

function pageSize(params: Record<string, unknown>, runtime: SearchRuntime): number {
  const requested = Number(params.maxResults);
  const applied = Number.isFinite(requested) && requested > 0
    ? Math.round(requested)
    : runtime.defaultPageSize;
  return Math.min(applied, runtime.maxPageSize);
}

function cursorValue(params: Record<string, unknown>): number {
  return Math.max(0, Math.round(Number(params.cursor) || 0));
}

function explicitSearchId(params: Record<string, unknown>): string | undefined {
  return typeof params.searchId === "string" && params.searchId.trim()
    ? params.searchId.trim()
    : undefined;
}

function metadataRangeReason(workerReason: string): string {
  return `ripgrep_metadata_${String(workerReason || "node_worker_error").replace(/^node_/, "")}`;
}

function sortContentStable(matches: ContentMatch[], mtimes?: Map<string, number>): void {
  matches.sort((left, right) => {
    const leftTime = mtimes?.get(left.file) ?? 0;
    const rightTime = mtimes?.get(right.file) ?? 0;
    if (rightTime !== leftTime) return rightTime - leftTime;
    if (left.file !== right.file) return left.file.localeCompare(right.file);
    return left.line - right.line;
  });
}

/**
 * ripgrep 只负责枚举；mtime/size 等文件系统读取进入既有可取消 worker。
 * worker 不可用时仍返回稳定的部分结果，并通过 rangeLimitReason 诚实降级。
 */
async function enrichRipgrepContent(
  matches: ContentMatch[],
  wsRoot: string,
  deadline: number,
  signal: AbortSignal | undefined,
  complete: boolean,
): Promise<CollectionResult<ContentMatch>> {
  if (matches.length === 0) return { items: matches, complete };
  const paths = [...new Set(matches.map((item) => item.file))]
    .map((file) => ({ path: file }));
  const metadata = await searchWithNodeWorker<MetadataMatch>({
    jobId: randomUUID(),
    kind: "content_metadata",
    records: paths,
    absPath: wsRoot,
    wsRoot,
    pattern: "",
    maxResults: Math.max(1, paths.length),
    deadlineEpochMs: deadline,
    maxFileSize: 0,
    skipDirs: [],
  }, signal);
  if (metadata.workerReason === "node_cancelled") {
    return {
      items: [],
      complete: false,
      fallbackReason: "ripgrep_cancelled",
      fallbackAllowed: false,
    };
  }
  if (metadata.workerReason === "node_completed") {
    const mtimes = new Map(metadata.items.map((item) => [item.path, Number(item.mtime) || 0]));
    sortContentStable(matches, mtimes);
    return { items: matches, complete };
  }
  sortContentStable(matches);
  return {
    items: matches,
    complete: false,
    rangeLimitReason: metadataRangeReason(metadata.workerReason),
    workerReason: metadata.workerReason,
  };
}

async function enrichRipgrepNames(
  results: NameMatch[],
  wsRoot: string,
  deadline: number,
  signal: AbortSignal | undefined,
  complete: boolean,
): Promise<CollectionResult<NameMatch>> {
  if (results.length === 0) return { items: results, complete };
  const metadata = await searchWithNodeWorker<NameMatch>({
    jobId: randomUUID(),
    kind: "name_metadata",
    records: results.map((item) => ({ path: item.path })),
    absPath: wsRoot,
    wsRoot,
    pattern: "",
    maxResults: Math.max(1, results.length),
    deadlineEpochMs: deadline,
    maxFileSize: 0,
    skipDirs: [],
  }, signal);
  if (metadata.workerReason === "node_cancelled") {
    return {
      items: [],
      complete: false,
      fallbackReason: "ripgrep_cancelled",
      fallbackAllowed: false,
    };
  }
  if (metadata.workerReason === "node_completed") {
    return { items: metadata.items, complete };
  }
  for (const item of results) {
    item.size = 0;
    item.mtime = 0;
  }
  results.sort((left, right) => left.path.localeCompare(right.path));
  return {
    items: results,
    complete: false,
    rangeLimitReason: metadataRangeReason(metadata.workerReason),
    workerReason: metadata.workerReason,
  };
}

function contentPage(
  snapshot: SearchSnapshot<ContentMatch>,
  cursor: number,
  size: number,
  pattern: string,
  directory: string,
  filePattern: string,
): Record<string, unknown> {
  const matches = snapshot.items.slice(cursor, cursor + size);
  const hasMore = cursor + matches.length < snapshot.items.length;
  const chars = matches.reduce(
    (sum, match) => sum + match.content.length + match.context.length,
    0,
  );
  return {
    pattern,
    directory,
    filePattern,
    matches,
    total: matches.length,
    truncated: hasMore || !snapshot.complete,
    nextCursor: hasMore ? cursor + matches.length : null,
    budgetHint: chars > 8000
      ? `本页约 ${Math.round(chars / 1000)}k 字符偏大：建议缩小 pattern 或加 filePattern`
      : undefined,
    searchId: snapshot.searchId,
    queryKey: snapshot.queryKey,
    snapshotAt: snapshot.snapshotAt,
    complete: snapshot.complete,
    snapshotCount: snapshot.items.length,
    pageCount: matches.length,
    engine: snapshot.engine,
    ...(snapshot.fallbackReason ? { fallbackReason: snapshot.fallbackReason } : {}),
    ...(snapshot.rangeLimitReason ? { rangeLimitReason: snapshot.rangeLimitReason } : {}),
    ...(snapshot.workerReason ? { workerReason: snapshot.workerReason } : {}),
  };
}

function namePage(
  snapshot: SearchSnapshot<NameMatch>,
  cursor: number,
  size: number,
  pattern: string,
  directory: string,
): Record<string, unknown> {
  const results = snapshot.items.slice(cursor, cursor + size);
  const hasMore = cursor + results.length < snapshot.items.length;
  return {
    pattern,
    directory,
    results,
    total: results.length,
    truncated: hasMore || !snapshot.complete,
    nextCursor: hasMore ? cursor + results.length : null,
    searchId: snapshot.searchId,
    queryKey: snapshot.queryKey,
    snapshotAt: snapshot.snapshotAt,
    complete: snapshot.complete,
    snapshotCount: snapshot.items.length,
    pageCount: results.length,
    engine: snapshot.engine,
    ...(snapshot.fallbackReason ? { fallbackReason: snapshot.fallbackReason } : {}),
    ...(snapshot.rangeLimitReason ? { rangeLimitReason: snapshot.rangeLimitReason } : {}),
    ...(snapshot.workerReason ? { workerReason: snapshot.workerReason } : {}),
  };
}

/**
 * ripgrep JSON 按行增量解析。达到全局 snapshot 上限后立即终止子进程，
 * 不使用按文件生效的 --max-count，也不缓冲完整 stdout。
 */
async function searchContentWithRipgrep(
  pattern: string,
  searchDir: string,
  filePattern: string,
  maxResults: number,
  wsRoot: string,
  ignoreCase: boolean,
  deadline: number,
  signal?: AbortSignal,
): Promise<CollectionResult<ContentMatch>> {
  return new Promise((resolve) => {
    const rgId = randomUUID();
    const remaining = remainingMs(deadline);
    if (remaining <= 0) {
      resolve({
        items: [],
        complete: false,
        fallbackReason: "ripgrep_deadline_exhausted",
      });
      return;
    }
    if (signal?.aborted) {
      resolve({
        items: [],
        complete: false,
        fallbackReason: "ripgrep_cancelled",
        fallbackAllowed: false,
      });
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
    const child = cp.spawn("rg", args, {
      windowsHide: true,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    publishRipgrepLifecycle(rgId, "content", "started");
    const decoder = new StringDecoder("utf8");
    const matches: ContentMatch[] = [];
    let carry = "";
    let stderr = "";
    let settled = false;
    let parseFailed = false;
    let stopRequested = false;
    let stopReason: string | undefined;
    let stopFallbackAllowed = true;
    let forceTimer: NodeJS.Timeout | undefined;
    let orphanTimer: NodeJS.Timeout | undefined;

    const finish = (result: CollectionResult<ContentMatch>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      if (orphanTimer) clearTimeout(orphanTimer);
      signal?.removeEventListener("abort", onAbort);
      publishRipgrepLifecycle(rgId, "content", "settled", {
        ok: !result.fallbackReason,
        reason: result.fallbackReason,
      });
      resolve(result);
    };
    const requestStop = (reason: string, fallbackAllowed = true) => {
      if (stopRequested || settled) return;
      stopRequested = true;
      stopReason = reason;
      stopFallbackAllowed = fallbackAllowed;
      publishRipgrepLifecycle(rgId, "content", "stop_requested", { reason });
      try { child.stdout.pause(); } catch {}
      try { child.kill(); } catch {}
      forceTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
        orphanTimer = setTimeout(() => {
          finish({
            items: [],
            complete: false,
            fallbackReason: `${reason}_close_timeout`,
            fallbackAllowed: false,
          });
        }, 250);
        orphanTimer.unref();
      }, 250);
      forceTimer.unref();
    };
    const onAbort = () => requestStop("ripgrep_cancelled", false);
    const consumeLine = (line: string) => {
      if (!line || settled || stopRequested) return;
      try {
        const event = JSON.parse(line) as {
          type?: string;
          data?: {
            path?: { text?: string };
            lines?: { text?: string };
            line_number?: number;
          };
        };
        if (event.type !== "match" || !event.data) return;
        const rawPath = event.data.path?.text;
        if (!rawPath || !Number.isFinite(event.data.line_number)) {
          parseFailed = true;
          return;
        }
        const absolutePath = path.isAbsolute(rawPath)
          ? rawPath
          : path.resolve(searchDir, rawPath);
        const raw = (event.data.lines?.text || "").replace(/\r?\n$/, "");
        matches.push({
          file: path.relative(wsRoot, absolutePath).replace(/\\/g, "/"),
          line: Number(event.data.line_number),
          content: raw.trim(),
          context: raw,
        });
        if (matches.length >= maxResults) requestStop("ripgrep_result_limit");
      } catch {
        parseFailed = true;
        requestStop("ripgrep_parse_error");
      }
    };
    const consumeChunk = (chunk: Buffer) => {
      carry += decoder.write(chunk);
      const lines = carry.split(/\r?\n/);
      carry = lines.pop() || "";
      for (const line of lines) {
        consumeLine(line);
        if (stopRequested) break;
      }
    };

    const timer = setTimeout(() => {
      requestStop("ripgrep_timeout");
    }, remaining);
    timer.unref();

    child.stdout.on("data", consumeChunk);
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 500) stderr += chunk.toString("utf8").slice(0, 500 - stderr.length);
    });
    child.on("error", (error) => {
      stopReason = "ripgrep_unavailable";
      publishRipgrepLifecycle(rgId, "content", "error");
      if (stderr.length < 500) stderr += error.message.slice(0, 500 - stderr.length);
    });
    child.on("close", async (code) => {
      if (settled) return;
      publishRipgrepLifecycle(rgId, "content", "close", { code });
      if (forceTimer) clearTimeout(forceTimer);
      if (orphanTimer) clearTimeout(orphanTimer);
      if (stopReason === "ripgrep_result_limit") {
        finish(await enrichRipgrepContent(matches, wsRoot, deadline, signal, false));
        return;
      }
      if (stopReason) {
        finish({
          items: [],
          complete: false,
          fallbackReason: `${stopReason}${stderr ? `:${stderr.trim()}` : ""}`,
          fallbackAllowed: stopFallbackAllowed,
        });
        return;
      }
      carry += decoder.end();
      if (carry) consumeLine(carry);
      if (settled) return;
      if (parseFailed) {
        finish({ items: [], complete: false, fallbackReason: "ripgrep_parse_error" });
        return;
      }
      if (code === 0 || code === 1) {
        finish(await enrichRipgrepContent(matches, wsRoot, deadline, signal, true));
        return;
      }
      finish({
        items: [],
        complete: false,
        fallbackReason: `ripgrep_exit_${code ?? "null"}${stderr ? `:${stderr.trim()}` : ""}`,
      });
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

/** ripgrep --files 按行增量解析；达到全局 snapshot 上限后立即终止。 */
async function searchNamesWithRipgrep(
  pattern: string,
  searchDir: string,
  maxResults: number,
  wsRoot: string,
  deadline: number,
  signal?: AbortSignal,
): Promise<CollectionResult<NameMatch>> {
  return new Promise((resolve) => {
    const rgId = randomUUID();
    const remaining = remainingMs(deadline);
    if (remaining <= 0) {
      resolve({
        items: [],
        complete: false,
        fallbackReason: "ripgrep_deadline_exhausted",
      });
      return;
    }
    if (signal?.aborted) {
      resolve({
        items: [],
        complete: false,
        fallbackReason: "ripgrep_cancelled",
        fallbackAllowed: false,
      });
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
    const child = cp.spawn("rg", args, {
      windowsHide: true,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    publishRipgrepLifecycle(rgId, "name", "started");
    const decoder = new StringDecoder("utf8");
    const results: NameMatch[] = [];
    let carry = "";
    let stderr = "";
    let settled = false;
    let stopRequested = false;
    let stopReason: string | undefined;
    let stopFallbackAllowed = true;
    let forceTimer: NodeJS.Timeout | undefined;
    let orphanTimer: NodeJS.Timeout | undefined;

    const finish = (result: CollectionResult<NameMatch>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      if (orphanTimer) clearTimeout(orphanTimer);
      signal?.removeEventListener("abort", onAbort);
      publishRipgrepLifecycle(rgId, "name", "settled", {
        ok: !result.fallbackReason,
        reason: result.fallbackReason,
      });
      resolve(result);
    };
    const requestStop = (reason: string, fallbackAllowed = true) => {
      if (stopRequested || settled) return;
      stopRequested = true;
      stopReason = reason;
      stopFallbackAllowed = fallbackAllowed;
      publishRipgrepLifecycle(rgId, "name", "stop_requested", { reason });
      try { child.stdout.pause(); } catch {}
      try { child.kill(); } catch {}
      forceTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
        orphanTimer = setTimeout(() => {
          finish({
            items: [],
            complete: false,
            fallbackReason: `${reason}_close_timeout`,
            fallbackAllowed: false,
          });
        }, 250);
        orphanTimer.unref();
      }, 250);
      forceTimer.unref();
    };
    const onAbort = () => requestStop("ripgrep_cancelled", false);
    const consumeLine = (line: string) => {
      const rawPath = line.trim();
      if (!rawPath || settled || stopRequested) return;
      const absolutePath = path.isAbsolute(rawPath)
        ? rawPath
        : path.resolve(searchDir, rawPath);
      results.push({
        name: path.basename(absolutePath),
        path: path.relative(wsRoot, absolutePath).replace(/\\/g, "/"),
        size: 0,
        mtime: 0,
      });
      if (results.length >= maxResults) requestStop("ripgrep_result_limit");
    };
    const timer = setTimeout(() => {
      requestStop("ripgrep_timeout");
    }, remaining);
    timer.unref();

    child.stdout.on("data", (chunk: Buffer) => {
      carry += decoder.write(chunk);
      const lines = carry.split(/\r?\n/);
      carry = lines.pop() || "";
      for (const line of lines) {
        consumeLine(line);
        if (stopRequested) break;
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 500) stderr += chunk.toString("utf8").slice(0, 500 - stderr.length);
    });
    child.on("error", (error) => {
      stopReason = "ripgrep_unavailable";
      publishRipgrepLifecycle(rgId, "name", "error");
      if (stderr.length < 500) stderr += error.message.slice(0, 500 - stderr.length);
    });
    child.on("close", async (code) => {
      if (settled) return;
      publishRipgrepLifecycle(rgId, "name", "close", { code });
      if (forceTimer) clearTimeout(forceTimer);
      if (orphanTimer) clearTimeout(orphanTimer);
      if (stopReason === "ripgrep_result_limit") {
        finish(await enrichRipgrepNames(results, wsRoot, deadline, signal, false));
        return;
      }
      if (stopReason) {
        finish({
          items: [],
          complete: false,
          fallbackReason: `${stopReason}${stderr ? `:${stderr.trim()}` : ""}`,
          fallbackAllowed: stopFallbackAllowed,
        });
        return;
      }
      carry += decoder.end();
      if (carry) consumeLine(carry);
      if (settled) return;
      if (code === 0 || code === 1) {
        finish(await enrichRipgrepNames(results, wsRoot, deadline, signal, true));
        return;
      }
      finish({
        items: [],
        complete: false,
        fallbackReason: `ripgrep_exit_${code ?? "null"}${stderr ? `:${stderr.trim()}` : ""}`,
      });
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

interface NodeSearchJob {
  jobId: string;
  kind: SearchKind | "content_metadata" | "name_metadata";
  absPath: string;
  wsRoot: string;
  pattern: string;
  filePattern?: string;
  ignoreCase?: boolean;
  maxResults: number;
  deadlineEpochMs: number;
  maxFileSize: number;
  skipDirs: string[];
  records?: Array<{ path: string }>;
}

interface NodeWorkerMessage {
  type?: string;
  jobId?: string;
  records?: WorkerRecord[];
  complete?: boolean;
  workerReason?: string;
  rangeLimitReason?: string;
  errorCode?: "invalid_regex";
  errorMessage?: string;
}

interface NodeWorkerCollection<T extends WorkerRecord> extends CollectionResult<T> {
  workerReason: string;
  errorCode?: "invalid_regex";
  errorMessage?: string;
}

const NODE_SEARCH_WORKER_PATH = path.join(__dirname, "node-search-worker.js");
const NODE_SEARCH_LIFECYCLE = channel("beilu.node-search-worker");
const RIPGREP_SEARCH_LIFECYCLE = channel("beilu.ripgrep-search");

function publishWorkerLifecycle(
  jobId: string,
  event: string,
  detail: Record<string, unknown> = {},
): void {
  try {
    NODE_SEARCH_LIFECYCLE.publish({
      backend: "yonban",
      jobId,
      event,
      at: Date.now(),
      ...detail,
    });
  } catch { /* diagnostics subscriber must not affect execution */ }
}

function publishRipgrepLifecycle(
  rgId: string,
  kind: SearchKind,
  event: string,
  detail: Record<string, unknown> = {},
): void {
  try {
    RIPGREP_SEARCH_LIFECYCLE.publish({
      backend: "yonban",
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
async function searchWithNodeWorker<T extends WorkerRecord>(
  job: NodeSearchJob,
  externalSignal?: AbortSignal,
): Promise<NodeWorkerCollection<T>> {
  const remaining = remainingMs(job.deadlineEpochMs);
  if (remaining <= 0) {
    return { items: [], complete: false, workerReason: "node_timeout" };
  }
  if (externalSignal?.aborted) {
    return { items: [], complete: false, workerReason: "node_cancelled" };
  }

  let worker: Worker;
  try {
    publishWorkerLifecycle(job.jobId, "start_attempt");
    worker = new Worker(NODE_SEARCH_WORKER_PATH, { workerData: job });
    publishWorkerLifecycle(job.jobId, "started");
  } catch {
    publishWorkerLifecycle(job.jobId, "start_failed");
    return { items: [], complete: false, workerReason: "node_worker_start_failed" };
  }

  return new Promise((resolve) => {
    const controller = new AbortController();
    let workerResult: NodeWorkerMessage | undefined;
    let workerError = false;
    let cancelling = false;
    let settled = false;
    let exitCode: number | null = null;
    let deadlineTimer: NodeJS.Timeout | undefined;
    let resolveExit!: (code: number) => void;
    const exitPromise = new Promise<number>((exitResolve) => {
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
    const finish = (result: NodeWorkerCollection<T>) => {
      if (settled) return;
      settled = true;
      publishWorkerLifecycle(job.jobId, "settled", { reason: result.workerReason });
      cleanup();
      resolve(result);
    };
    const cancelWorker = async (reason: "node_timeout" | "node_cancelled") => {
      if (cancelling || settled) return;
      cancelling = true;
      publishWorkerLifecycle(job.jobId, "cancel_requested", { reason });
      try { worker.postMessage({ type: "cancel", jobId: job.jobId }); } catch {}
      try {
        await worker.terminate();
        await exitPromise;
      } catch {
        await exitPromise;
      }
      publishWorkerLifecycle(job.jobId, "terminated", { reason, exitCode });
      finish({ items: [], complete: false, workerReason: reason });
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

    worker.on("message", (message: NodeWorkerMessage) => {
      if (
        settled
        || cancelling
        || message?.type !== "result"
        || message.jobId !== job.jobId
      ) {
        return;
      }
      workerResult = message;
      publishWorkerLifecycle(job.jobId, "message", { reason: message.workerReason });
    });
    worker.on("error", () => {
      workerError = true;
      publishWorkerLifecycle(job.jobId, "error");
    });
    worker.once("exit", (code) => {
      exitCode = code;
      publishWorkerLifecycle(job.jobId, "exit", { code });
      resolveExit(code);
      if (cancelling || settled) return;
      if (workerError) {
        finish({ items: [], complete: false, workerReason: "node_worker_error" });
        return;
      }
      if (!workerResult) {
        finish({
          items: [],
          complete: false,
          workerReason: code === 0 ? "node_worker_no_result" : `node_worker_exit_${code}`,
        });
        return;
      }
      if (workerResult.errorCode === "invalid_regex") {
        finish({
          items: [],
          complete: false,
          workerReason: workerResult.workerReason || "node_invalid_regex",
          errorCode: "invalid_regex",
          errorMessage: workerResult.errorMessage,
        });
        return;
      }
      finish({
        items: Array.isArray(workerResult.records) ? workerResult.records as T[] : [],
        complete: workerResult.complete === true,
        workerReason: workerResult.workerReason
          || (exitCode === 0 ? "node_completed" : `node_worker_exit_${exitCode}`),
        ...(workerResult.rangeLimitReason ? { rangeLimitReason: workerResult.rangeLimitReason } : {}),
      });
    });

    deadlineTimer = setTimeout(() => {
      if (!controller.signal.aborted) controller.abort("node_timeout");
    }, remainingMs(job.deadlineEpochMs));
    deadlineTimer.unref();
    controller.signal.addEventListener("abort", onAbort, { once: true });
    externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
    if (externalSignal?.aborted) onExternalAbort();
  });
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("node_cancelled: 搜索调用已由连接生命周期取消");
  error.name = "AbortError";
  throw error;
}

async function targetStat(absPath: string, displayPath: string): Promise<fs.Stats> {
  try {
    return await fs.promises.stat(absPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new Error(`路径不存在: ${displayPath}`);
    }
    throw error;
  }
}

/** 搜索文件内容（正则匹配）：ripgrep 增量快照，明确回退到 Node。 */
export async function searchFiles(
  params: Record<string, unknown>,
  context?: SearchCallContext,
): Promise<unknown> {
  let pattern = (params.pattern || params.query) as string;
  if (!pattern) throw new Error("缺少 pattern 参数（也接受 query）");
  if (params.fuzzyIdentifier ?? params.identifier_fuzzy ?? params.fuzzy_identifier) {
    pattern = identifierFuzzyPattern(pattern);
  }

  const searchPath = (params.path as string) || ".";
  const filePattern = (params.filePattern as string) || "*";
  const ignoreCase = !!(params.ignoreCase ?? params.ignore_case);
  const absPath = resolveWorkspacePath(searchPath);

  const runtime = searchRuntime(params, context);
  const snapshotOwner = ownerKey(params, context);
  const cursor = cursorValue(params);
  const appliedPageSize = pageSize(params, runtime);
  const wsRoot = normalizeFsPath(getWorkspaceRoot());
  const key = queryKey({
    kind: "content",
    pattern,
    path: normalizeFsPath(absPath),
    filePattern,
    ignoreCase,
    workspaceRoot: wsRoot,
  });

  if (cursor > 0) {
    const snapshot = getSnapshot<ContentMatch>(
      "content",
      key,
      wsRoot,
      explicitSearchId(params),
      snapshotOwner,
    );
    return contentPage(snapshot, cursor, appliedPageSize, pattern, searchPath, filePattern);
  }

  let engine: SearchEngine = "ripgrep";
  let collection: CollectionResult<ContentMatch>;
  const deadline = Date.now() + runtime.timeoutMs;
  const signal = context?.signal;
  const target = await targetStat(absPath, searchPath);
  throwIfCancelled(signal);
  if (target.isFile()) {
    engine = "node";
    const nodeResult = await searchWithNodeWorker<ContentMatch>({
      jobId: randomUUID(),
      kind: "content",
      absPath,
      wsRoot,
      pattern,
      filePattern,
      ignoreCase,
      maxResults: runtime.maxSnapshotResults,
      deadlineEpochMs: deadline,
      maxFileSize: MAX_SEARCH_FILE_SIZE,
      skipDirs: [...SKIP_DIRS],
    }, signal);
    throwIfCancelled(signal);
    if (nodeResult.errorCode === "invalid_regex") {
      throw new Error(nodeResult.errorMessage || `无效的正则表达式: ${pattern}`);
    }
    collection = {
      items: nodeResult.items,
      complete: nodeResult.complete,
      workerReason: nodeResult.workerReason,
      fallbackReason: ["node_completed", "node_result_limit"].includes(nodeResult.workerReason)
        ? "ripgrep_not_applicable_file_target"
        : appendReason("ripgrep_not_applicable_file_target", nodeResult.workerReason),
      ...(nodeResult.rangeLimitReason ? { rangeLimitReason: nodeResult.rangeLimitReason } : {}),
    };
  } else {
    const ripgrep = await searchContentWithRipgrep(
      pattern,
      absPath,
      filePattern,
      runtime.maxSnapshotResults,
      wsRoot,
      ignoreCase,
      deadline,
      signal,
    );
    throwIfCancelled(signal);
    if (ripgrep.fallbackReason && ripgrep.fallbackAllowed !== false && remainingMs(deadline) > 0) {
      engine = "node";
      const nodeResult = await searchWithNodeWorker<ContentMatch>({
        jobId: randomUUID(),
        kind: "content",
        absPath,
        wsRoot,
        pattern,
        filePattern,
        ignoreCase,
        maxResults: runtime.maxSnapshotResults,
        deadlineEpochMs: deadline,
        maxFileSize: MAX_SEARCH_FILE_SIZE,
        skipDirs: [...SKIP_DIRS],
      }, signal);
      throwIfCancelled(signal);
      if (nodeResult.errorCode === "invalid_regex") {
        throw new Error(nodeResult.errorMessage || `无效的正则表达式: ${pattern}`);
      }
      collection = {
        items: nodeResult.items,
        complete: nodeResult.complete,
        workerReason: nodeResult.workerReason,
        fallbackReason: ["node_completed", "node_result_limit"].includes(nodeResult.workerReason)
          ? ripgrep.fallbackReason
          : appendReason(ripgrep.fallbackReason, nodeResult.workerReason),
        ...(nodeResult.rangeLimitReason ? { rangeLimitReason: nodeResult.rangeLimitReason } : {}),
      };
    } else {
      collection = ripgrep;
    }
  }

  if (collection.fallbackReason && engine === "ripgrep" && remainingMs(deadline) <= 0) {
    collection.fallbackReason = appendReason(collection.fallbackReason, "node_deadline_exhausted");
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  throwIfCancelled(signal);
  const snapshot = createSnapshot(
    "content",
    key,
    wsRoot,
    runtime,
    engine,
    collection,
    snapshotOwner,
  );
  return contentPage(snapshot, 0, appliedPageSize, pattern, searchPath, filePattern);
}

/** 按文件名搜索：ripgrep --files 增量快照，明确回退到 Node walk。 */
export async function searchByName(
  params: Record<string, unknown>,
  context?: SearchCallContext,
): Promise<unknown> {
  const pattern = params.pattern as string;
  if (!pattern) throw new Error("缺少 pattern 参数");
  const searchPath = (params.path as string) || ".";
  const absPath = resolveWorkspacePath(searchPath);

  const runtime = searchRuntime(params, context);
  const snapshotOwner = ownerKey(params, context);
  const cursor = cursorValue(params);
  const appliedPageSize = pageSize(params, runtime);
  const wsRoot = normalizeFsPath(getWorkspaceRoot());
  const namePattern = pattern.replace(/^(\*\*\/)+/, "") || pattern;
  const key = queryKey({
    kind: "name",
    pattern: namePattern,
    path: normalizeFsPath(absPath),
    workspaceRoot: wsRoot,
  });

  if (cursor > 0) {
    const snapshot = getSnapshot<NameMatch>(
      "name",
      key,
      wsRoot,
      explicitSearchId(params),
      snapshotOwner,
    );
    return namePage(snapshot, cursor, appliedPageSize, pattern, searchPath);
  }

  let engine: SearchEngine = "ripgrep";
  let collection: CollectionResult<NameMatch>;
  const deadline = Date.now() + runtime.timeoutMs;
  const signal = context?.signal;
  const target = await targetStat(absPath, searchPath);
  throwIfCancelled(signal);
  if (target.isFile()) {
    engine = "node";
    const nodeResult = await searchWithNodeWorker<NameMatch>({
      jobId: randomUUID(),
      kind: "name",
      absPath,
      wsRoot,
      pattern: namePattern,
      maxResults: runtime.maxSnapshotResults,
      deadlineEpochMs: deadline,
      maxFileSize: MAX_SEARCH_FILE_SIZE,
      skipDirs: [...SKIP_DIRS],
    }, signal);
    throwIfCancelled(signal);
    collection = {
      items: nodeResult.items,
      complete: nodeResult.complete,
      workerReason: nodeResult.workerReason,
      fallbackReason: ["node_completed", "node_result_limit"].includes(nodeResult.workerReason)
        ? "ripgrep_not_applicable_file_target"
        : appendReason("ripgrep_not_applicable_file_target", nodeResult.workerReason),
      ...(nodeResult.rangeLimitReason ? { rangeLimitReason: nodeResult.rangeLimitReason } : {}),
    };
  } else {
    const ripgrep = await searchNamesWithRipgrep(
      namePattern,
      absPath,
      runtime.maxSnapshotResults,
      wsRoot,
      deadline,
      signal,
    );
    throwIfCancelled(signal);
    if (ripgrep.fallbackReason && ripgrep.fallbackAllowed !== false && remainingMs(deadline) > 0) {
      engine = "node";
      const nodeResult = await searchWithNodeWorker<NameMatch>({
        jobId: randomUUID(),
        kind: "name",
        absPath,
        wsRoot,
        pattern: namePattern,
        maxResults: runtime.maxSnapshotResults,
        deadlineEpochMs: deadline,
        maxFileSize: MAX_SEARCH_FILE_SIZE,
        skipDirs: [...SKIP_DIRS],
      }, signal);
      throwIfCancelled(signal);
      collection = {
        items: nodeResult.items,
        complete: nodeResult.complete,
        workerReason: nodeResult.workerReason,
        fallbackReason: ["node_completed", "node_result_limit"].includes(nodeResult.workerReason)
          ? ripgrep.fallbackReason
          : appendReason(ripgrep.fallbackReason, nodeResult.workerReason),
        ...(nodeResult.rangeLimitReason ? { rangeLimitReason: nodeResult.rangeLimitReason } : {}),
      };
    } else {
      collection = ripgrep;
    }
  }

  if (collection.fallbackReason && engine === "ripgrep" && remainingMs(deadline) <= 0) {
    collection.fallbackReason = appendReason(collection.fallbackReason, "node_deadline_exhausted");
  }

  ideOpLog(
    "search_by_name",
    "debug",
    {
      absPath,
      pattern,
      namePattern,
      engine,
      count: collection.items.length,
      fallbackReason: collection.fallbackReason,
    },
      "ok",
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  throwIfCancelled(signal);
  const snapshot = createSnapshot(
    "name",
    key,
    wsRoot,
    runtime,
    engine,
    collection,
    snapshotOwner,
  );
  return namePage(snapshot, 0, appliedPageSize, pattern, searchPath);
}

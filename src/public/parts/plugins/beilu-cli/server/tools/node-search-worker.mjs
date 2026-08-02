/**
 * Node 搜索 fallback 的同步文件系统/正则隔离区。
 *
 * 只接收主线程归一化后的纯数据，不读取 owner/runtimePolicy/raw params，
 * 不访问 snapshot、WebSocket 或其他执行端状态。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parentPort, workerData } from "node:worker_threads";

if (!parentPort) {
  throw new Error("node_search_worker_parent_port_missing");
}

const job = workerData && typeof workerData === "object" ? workerData : {};
const jobId = typeof job.jobId === "string" ? job.jobId : "";
let cancelRequested = false;

parentPort.on("message", (message) => {
  if (
    message
    && message.type === "cancel"
    && message.jobId === jobId
  ) {
    cancelRequested = true;
  }
});

function appendReason(existing, reason) {
  if (!existing) return reason;
  return existing.split(";").includes(reason) ? existing : `${existing};${reason}`;
}

function globToRegex(glob) {
  let pattern = "";
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index];
    if (char === "*") {
      if (glob[index + 1] === "*") {
        index++;
        if (glob[index + 1] === "/") {
          index++;
          pattern += "(?:.*/)?";
        } else {
          pattern += ".*";
        }
      } else {
        pattern += "[^/]*";
      }
    } else if (char === "?") {
      pattern += "[^/]";
    } else if (char === "{") {
      const end = glob.indexOf("}", index + 1);
      if (end > index) {
        const alternatives = glob.slice(index + 1, end)
          .split(",")
          .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
        pattern += `(?:${alternatives.join("|")})`;
        index = end;
      } else {
        pattern += "\\{";
      }
    } else {
      pattern += char.replace(/[.+^$()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${pattern}$`, "i");
}

function stopReason(count) {
  if (cancelRequested) return "node_cancelled";
  if (count >= job.maxResults) return "node_result_limit";
  if (Date.now() >= job.deadlineEpochMs) return "node_timeout";
  return null;
}

function searchContent() {
  let regex;
  try {
    regex = new RegExp(job.pattern, job.ignoreCase ? "gi" : "g");
  } catch {
    return {
      records: [],
      complete: false,
      workerReason: "node_invalid_regex",
      errorCode: "invalid_regex",
      errorMessage: `无效的正则表达式: ${job.pattern}`,
    };
  }

  const matches = [];
  const skipDirs = new Set(Array.isArray(job.skipDirs) ? job.skipDirs : []);
  const filePattern = typeof job.filePattern === "string" ? job.filePattern : "*";
  const nameRegex = filePattern === "*" ? null : globToRegex(filePattern);
  const targetStat = fs.statSync(job.absPath);
  const searchBase = targetStat.isFile() ? path.dirname(job.absPath) : job.absPath;
  let workerReason = "node_completed";
  let rangeLimitReason;

  const shouldStop = () => {
    const reason = stopReason(matches.length);
    if (!reason) return false;
    workerReason = reason;
    return true;
  };
  const matchesFilePattern = (file) => {
    if (!nameRegex) return true;
    const relative = path.relative(searchBase, file).replace(/\\/g, "/");
    return nameRegex.test(filePattern.includes("/") ? relative : path.basename(file));
  };
  const scanFile = (file) => {
    if (shouldStop()) return;
    try {
      const stat = fs.statSync(file);
      if (stat.size > job.maxFileSize) {
        rangeLimitReason = appendReason(rangeLimitReason, "node_max_file_size");
        return;
      }
      const text = fs.readFileSync(file, "utf8")
        .replace(/^\uFEFF/, "")
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n");
      const lines = text.split("\n");
      for (let index = 0; index < lines.length; index++) {
        if (shouldStop()) break;
        regex.lastIndex = 0;
        if (!regex.test(lines[index])) continue;
        const contextStart = Math.max(0, index - 1);
        const contextEnd = Math.min(lines.length, index + 2);
        matches.push({
          file: path.relative(job.wsRoot, file).replace(/\\/g, "/"),
          line: index + 1,
          content: lines[index].trim(),
          context: lines.slice(contextStart, contextEnd).join("\n"),
        });
        if (matches.length >= job.maxResults) {
          workerReason = "node_result_limit";
          break;
        }
      }
    } catch {
      rangeLimitReason = appendReason(rangeLimitReason, "node_unreadable_path");
    }
  };
  const walk = (directory) => {
    if (shouldStop()) return;
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      rangeLimitReason = appendReason(rangeLimitReason, "node_unreadable_path");
      return;
    }
    for (const entry of entries) {
      if (shouldStop()) break;
      if (skipDirs.has(entry.name)) continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && matchesFilePattern(fullPath)) {
        scanFile(fullPath);
      }
    }
  };

  if (targetStat.isFile()) {
    if (matchesFilePattern(job.absPath)) scanFile(job.absPath);
  } else {
    walk(job.absPath);
  }

  if (!shouldStop()) {
    const mtimes = new Map();
    for (const file of new Set(matches.map((match) => match.file))) {
      const absolute = path.resolve(job.wsRoot, file);
      try { mtimes.set(absolute, fs.statSync(absolute).mtimeMs); }
      catch { mtimes.set(absolute, 0); }
    }
    matches.sort((left, right) => {
      const leftTime = mtimes.get(path.resolve(job.wsRoot, left.file)) ?? 0;
      const rightTime = mtimes.get(path.resolve(job.wsRoot, right.file)) ?? 0;
      if (rightTime !== leftTime) return rightTime - leftTime;
      if (left.file !== right.file) return left.file.localeCompare(right.file);
      return left.line - right.line;
    });
  }

  return {
    records: matches,
    complete: workerReason === "node_completed" && !rangeLimitReason,
    workerReason,
    rangeLimitReason,
  };
}

function searchNames() {
  const nameRegex = globToRegex(job.pattern);
  const results = [];
  const skipDirs = new Set(Array.isArray(job.skipDirs) ? job.skipDirs : []);
  const targetStat = fs.statSync(job.absPath);
  const searchBase = targetStat.isFile() ? path.dirname(job.absPath) : job.absPath;
  let workerReason = "node_completed";
  let rangeLimitReason;

  const shouldStop = () => {
    const reason = stopReason(results.length);
    if (!reason) return false;
    workerReason = reason;
    return true;
  };
  const addFile = (file) => {
    if (shouldStop()) return;
    const relative = path.relative(searchBase, file).replace(/\\/g, "/");
    const matchTarget = job.pattern.includes("/") ? relative : path.basename(file);
    if (!nameRegex.test(matchTarget)) return;
    let size = 0;
    let mtime = 0;
    try {
      const stat = fs.statSync(file);
      size = stat.size;
      mtime = stat.mtimeMs;
    } catch {
      rangeLimitReason = appendReason(rangeLimitReason, "node_unreadable_path");
    }
    results.push({
      name: path.basename(file),
      path: path.relative(job.wsRoot, file).replace(/\\/g, "/"),
      size,
      mtime,
    });
    if (results.length >= job.maxResults) workerReason = "node_result_limit";
  };
  const walk = (directory) => {
    if (shouldStop()) return;
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      rangeLimitReason = appendReason(rangeLimitReason, "node_unreadable_path");
      return;
    }
    for (const entry of entries) {
      if (shouldStop()) break;
      if (skipDirs.has(entry.name)) continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (entry.isFile()) addFile(fullPath);
    }
  };

  if (targetStat.isFile()) addFile(job.absPath);
  else walk(job.absPath);

  if (!shouldStop()) {
    results.sort((left, right) => right.mtime - left.mtime || left.path.localeCompare(right.path));
  }
  return {
    records: results,
    complete: workerReason === "node_completed" && !rangeLimitReason,
    workerReason,
    rangeLimitReason,
  };
}

/**
 * ripgrep 已完成枚举时，只在 worker 内补 metadata。
 * 主线程只传相对路径，避免复制整段内容匹配上下文。
 */
function collectContentMetadata() {
  const records = [];
  for (const item of Array.isArray(job.records) ? job.records : []) {
    const reason = stopReason(-1);
    if (reason) {
      return { records: [], complete: false, workerReason: reason };
    }
    const relativePath = typeof item?.path === "string" ? item.path : "";
    if (!relativePath) continue;
    const absolute = path.resolve(job.wsRoot, relativePath);
    let mtime = 0;
    try { mtime = fs.statSync(absolute).mtimeMs; } catch { /* 与旧成功路径一致：读不到记 0 */ }
    records.push({ path: relativePath, mtime });
  }
  return {
    records,
    complete: true,
    workerReason: "node_completed",
  };
}

function collectNameMetadata() {
  const records = [];
  for (const item of Array.isArray(job.records) ? job.records : []) {
    const reason = stopReason(-1);
    if (reason) {
      return { records: [], complete: false, workerReason: reason };
    }
    const relativePath = typeof item?.path === "string" ? item.path : "";
    if (!relativePath) continue;
    const absolute = path.resolve(job.wsRoot, relativePath);
    let size = 0;
    let mtime = 0;
    try {
      const stat = fs.statSync(absolute);
      size = stat.size;
      mtime = stat.mtimeMs;
    } catch { /* 与旧成功路径一致：保留条目，metadata 置 0 */ }
    records.push({
      name: path.basename(absolute),
      path: relativePath,
      size,
      mtime,
    });
  }
  records.sort((left, right) => right.mtime - left.mtime || left.path.localeCompare(right.path));
  return {
    records,
    complete: true,
    workerReason: "node_completed",
  };
}

function postResult(result) {
  parentPort.postMessage({
    type: "result",
    jobId,
    ...result,
  });
  parentPort.close();
}

try {
  if (!jobId || !["content", "name", "content_metadata", "name_metadata"].includes(job.kind)) {
    postResult({
      records: [],
      complete: false,
      workerReason: "node_worker_error",
    });
  } else {
    const handlers = {
      content: searchContent,
      name: searchNames,
      content_metadata: collectContentMetadata,
      name_metadata: collectNameMetadata,
    };
    postResult(handlers[job.kind]());
  }
} catch {
  postResult({
    records: [],
    complete: false,
    workerReason: "node_worker_error",
  });
}

/**
 * checkpoint.mjs — 文件操作快照系统（从 YonBan FileCheckpoint.ts 移植）
 * 唯一差异：工作区根由构造函数注入，不读 vscode.workspace
 */
import * as fs from "node:fs";
import * as path from "node:path";

export class FileCheckpoint {
  _checkpoints = new Map();
  _activeId = null;
  _pinnedId = null;
  _seqCounter = 0;
  _persistDir = null;
  _wsRoot;

  static MAX_CHECKPOINTS = 50;

  constructor(workspaceRoot) {
    this._wsRoot = workspaceRoot || process.cwd();
    this._initPersistDir();
  }

  _initPersistDir() {
    try {
      this._persistDir = path.join(this._wsRoot, ".beilu", "checkpoints");
      if (!fs.existsSync(this._persistDir)) {
        fs.mkdirSync(this._persistDir, { recursive: true });
      }
      this._loadFromDisk();
    } catch (e) {
      console.warn(`[FileCheckpoint] 持久化初始化失败，降级为纯内存模式: ${e}`);
      this._persistDir = null;
    }
  }

  /** 工作区根热切（canonical 单源变更时经 ToolExecutor 调用）：路径解析/持久化目录随根迁移，
   *  否则热切后新快照仍锚旧根=回档写错位置。旧根历史检查点留在旧目录（跨根回档语义不明，不迁移）。 */
  setWorkspaceRoot(root) {
    if (!root || root === this._wsRoot) return;
    this._wsRoot = root;
    this._checkpoints.clear(); // 旧根快照的相对路径在新根下无意义，清内存防误回档
    this._initPersistDir();
  }

  _getWorkspaceRoot() {
    return this._wsRoot;
  }

  _resolveWorkspacePath(relPath) {
    if (path.isAbsolute(relPath)) return relPath;
    return path.join(this._getWorkspaceRoot(), relPath);
  }

  start(id, chatId, messageIndex, deferred = false) {
    if (!deferred && this._activeId && this._activeId !== id) {
      this.commit(this._activeId);
    }
    if (!this._checkpoints.has(id)) {
      this._checkpoints.set(id, {
        id,
        timestamp: new Date().toISOString(),
        chatId,
        messageIndex,
        snapshots: [],
        operations: [],
        committed: false,
        seq: this._seqCounter++,
      });
    }
    if (!deferred) this._activeId = id;
    this._pruneOldCheckpoints();
  }

  pinTarget(id) { this._pinnedId = id; }
  unpinTarget() { this._pinnedId = null; }

  _resolveTargetId() {
    if (this._pinnedId) {
      const pinned = this._checkpoints.get(this._pinnedId);
      if (pinned && !pinned.committed) return this._pinnedId;
    }
    return this._activeId;
  }

  snapshotBeforeWrite(filePath) {
    const targetId = this._resolveTargetId();
    if (!targetId) return;
    const checkpoint = this._checkpoints.get(targetId);
    if (!checkpoint || checkpoint.committed) return;

    const absPath = this._resolveWorkspacePath(filePath);
    if (checkpoint.snapshots.some((s) => s.absPath === absPath)) return;

    let existed = false;
    let originalContent = null;
    try {
      if (fs.existsSync(absPath) && fs.statSync(absPath).isFile()) {
        existed = true;
        originalContent = fs.readFileSync(absPath).toString("base64");
      }
    } catch (err) {
      console.warn(`[FileCheckpoint] 快照读取失败: ${absPath}`, err?.message || String(err));
    }

    checkpoint.snapshots.push({ absPath, existed, originalContent, encoding: "base64" });
  }

  recordOperation(tool, params) {
    const targetId = this._resolveTargetId();
    if (!targetId) return;
    const checkpoint = this._checkpoints.get(targetId);
    if (!checkpoint || checkpoint.committed) return;
    checkpoint.operations.push({ tool, params: { ...params }, timestamp: new Date().toISOString(), author: "ai" });
  }

  commit(id) {
    const checkpoint = this._checkpoints.get(id);
    if (!checkpoint) return;
    checkpoint.committed = true;
    if (this._activeId === id) this._activeId = null;
    this._saveToDisk(checkpoint);
  }

  revert(id) {
    const checkpoint = this._checkpoints.get(id);
    if (!checkpoint) {
      return { success: false, restored: 0, deleted: 0, errors: [`检查点不存在: ${id}`], failedFiles: [] };
    }

    let restored = 0;
    let deleted = 0;
    const errors = [];
    const failedFiles = [];

    for (const snapshot of checkpoint.snapshots) {
      try {
        if (snapshot.existed && snapshot.originalContent !== null) {
          const dir = path.dirname(snapshot.absPath);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          if (snapshot.encoding === "base64") {
            this._atomicWriteFileSync(snapshot.absPath, Buffer.from(snapshot.originalContent, "base64"));
          } else {
            this._atomicWriteFileSync(snapshot.absPath, snapshot.originalContent);
          }
          restored++;
        } else {
          if (fs.existsSync(snapshot.absPath)) {
            fs.unlinkSync(snapshot.absPath);
            deleted++;
            this._cleanEmptyDirs(path.dirname(snapshot.absPath));
          }
        }
      } catch (err) {
        errors.push(`${snapshot.absPath}: ${err?.message || String(err)}`);
        failedFiles.push(snapshot.absPath);
      }
    }

    this._deleteFromDisk(id);
    this._checkpoints.delete(id);
    if (this._activeId === id) this._activeId = null;
    if (this._pinnedId === id) this._pinnedId = null;
    return { success: errors.length === 0, restored, deleted, errors, failedFiles };
  }

  _atomicWriteFileSync(absPath, data) {
    const tmp = `${absPath}.beilu-revert-${process.pid}-${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmp, data);
      for (let i = 0; ; i++) {
        try { fs.renameSync(tmp, absPath); break; }
        catch (e) {
          const code = e?.code;
          const transient = code === "EPERM" || code === "EBUSY" || code === "EACCES";
          if (!transient || i >= 4) throw e;
          // brief sync sleep for Windows antivirus locks
          try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); } catch { /* SAB unavailable */ }
        }
      }
    } catch (e) {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* best effort */ }
      throw e;
    }
  }

  revertToMessage(chatId, targetIndex) {
    const toRevert = [];
    for (const cp of this._checkpoints.values()) {
      if (cp.chatId === chatId && cp.messageIndex > targetIndex) toRevert.push(cp);
    }
    toRevert.sort((a, b) => b.messageIndex - a.messageIndex || b.seq - a.seq || new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    let totalRestored = 0, totalDeleted = 0;
    const allErrors = [], allFailedFiles = [];
    for (const cp of toRevert) {
      const result = this.revert(cp.id);
      totalRestored += result.restored;
      totalDeleted += result.deleted;
      allErrors.push(...result.errors);
      allFailedFiles.push(...result.failedFiles);
    }
    if (this._activeId && !this._checkpoints.has(this._activeId)) this._activeId = null;
    if (this._pinnedId && !this._checkpoints.has(this._pinnedId)) this._pinnedId = null;
    return { success: allErrors.length === 0, checkpointsReverted: toRevert.length, totalRestored, totalDeleted, errors: allErrors, failedFiles: allFailedFiles };
  }

  getRevertToMessageDiff(chatId, targetIndex) {
    const toRevert = [];
    for (const cp of this._checkpoints.values()) {
      if (cp.chatId === chatId && cp.messageIndex > targetIndex) toRevert.push(cp);
    }
    toRevert.sort((a, b) => b.messageIndex - a.messageIndex || b.seq - a.seq || new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    const verdict = new Map();
    for (const cp of toRevert) {
      for (const snapshot of cp.snapshots) {
        verdict.set(snapshot.absPath, (snapshot.existed && snapshot.originalContent !== null) ? "restore" : "delete");
      }
    }
    const filesToRestore = [], filesToDelete = [];
    for (const [absPath, v] of verdict) {
      if (v === "restore") filesToRestore.push(absPath);
      else filesToDelete.push(absPath);
    }
    return { checkpointsToRevert: toRevert.length, filesToRestore, filesToDelete };
  }

  getOperations(id) {
    const checkpoint = this._checkpoints.get(id);
    if (!checkpoint) return null;
    return [...checkpoint.operations];
  }

  getDiff(id) {
    const checkpoint = this._checkpoints.get(id);
    if (!checkpoint) return null;
    const _aiTouched = new Set();
    for (const op of checkpoint.operations) {
      const p = op.params?.path;
      if (typeof p === "string" && p) _aiTouched.add(path.resolve(this._getWorkspaceRoot(), p));
      const ps = op.params?.paths;
      if (Array.isArray(ps)) for (const pp of ps) if (typeof pp === "string") _aiTouched.add(path.resolve(this._getWorkspaceRoot(), pp));
    }
    const isBinary = (buf) => buf.includes(0);
    const decode = (s, enc) => enc === "base64" ? Buffer.from(s, "base64") : Buffer.from(s, "utf-8");
    const result = [];
    for (const snapshot of checkpoint.snapshots) {
      const rel = path.relative(this._getWorkspaceRoot(), snapshot.absPath).replace(/\\/g, "/");
      const oldBuf = snapshot.existed && snapshot.originalContent !== null ? decode(snapshot.originalContent, snapshot.encoding) : Buffer.alloc(0);
      let newBuf = Buffer.alloc(0);
      let deletedNow = false;
      try {
        if (fs.existsSync(snapshot.absPath)) newBuf = fs.readFileSync(snapshot.absPath);
        else deletedNow = snapshot.existed;
      } catch { deletedNow = snapshot.existed; }
      const author = _aiTouched.has(snapshot.absPath) ? "ai" : "human";
      const binary = isBinary(oldBuf) || isBinary(newBuf);
      if (binary) { result.push({ file: rel, existed: snapshot.existed, binary: true, deletedNow, author, hunks: [] }); continue; }
      const oldLines = snapshot.existed ? oldBuf.toString("utf-8").split("\n") : [];
      const newLines = deletedNow ? [] : newBuf.toString("utf-8").split("\n");
      result.push({ file: rel, existed: snapshot.existed, binary: false, deletedNow, author, hunks: FileCheckpoint._lineDiff(oldLines, newLines) });
    }
    return result;
  }

  static _lineDiff(a, b) {
    const n = a.length, m = b.length;
    const lcs = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
    const out = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { out.push({ type: "ctx", oldLine: i + 1, newLine: j + 1, content: a[i] }); i++; j++; }
      else if (lcs[i + 1][j] >= lcs[i][j + 1]) { out.push({ type: "del", oldLine: i + 1, newLine: null, content: a[i] }); i++; }
      else { out.push({ type: "add", oldLine: null, newLine: j + 1, content: b[j] }); j++; }
    }
    while (i < n) { out.push({ type: "del", oldLine: i + 1, newLine: null, content: a[i] }); i++; }
    while (j < m) { out.push({ type: "add", oldLine: null, newLine: j + 1, content: b[j] }); j++; }
    return out;
  }

  canReplay(id) {
    const checkpoint = this._checkpoints.get(id);
    if (!checkpoint) return { canReplay: false, changedFiles: [] };
    const changedFiles = [];
    for (const snapshot of checkpoint.snapshots) {
      try {
        if (!fs.existsSync(snapshot.absPath)) { if (snapshot.existed) changedFiles.push(snapshot.absPath); continue; }
        const currentContent = snapshot.encoding === "base64" ? fs.readFileSync(snapshot.absPath).toString("base64") : fs.readFileSync(snapshot.absPath, "utf-8");
        if (snapshot.existed && currentContent !== snapshot.originalContent) changedFiles.push(snapshot.absPath);
      } catch { changedFiles.push(snapshot.absPath); }
    }
    return { canReplay: changedFiles.length === 0, changedFiles };
  }

  list() {
    return Array.from(this._checkpoints.values()).map((cp) => ({
      id: cp.id, timestamp: cp.timestamp, chatId: cp.chatId, messageIndex: cp.messageIndex,
      fileCount: cp.snapshots.length, opCount: cp.operations.length, committed: cp.committed,
    }));
  }

  pruneAfter(chatId, targetIndex) {
    let count = 0;
    for (const [id, cp] of this._checkpoints) {
      if (cp.chatId === chatId && cp.messageIndex > targetIndex) {
        this._deleteFromDisk(id);
        this._checkpoints.delete(id);
        count++;
      }
    }
    return count;
  }

  _cleanEmptyDirs(dir) {
    const wsRoot = this._getWorkspaceRoot();
    try {
      if (!path.resolve(dir).startsWith(path.resolve(wsRoot))) return;
      if (dir === wsRoot) return;
      const entries = fs.readdirSync(dir);
      if (entries.length === 0) {
        fs.rmdirSync(dir);
        this._cleanEmptyDirs(path.dirname(dir));
      }
    } catch { /* ignore */ }
  }

  _saveToDisk(checkpoint) {
    if (!this._persistDir) return;
    try {
      const safeId = checkpoint.id.replace(/[<>:"/\\|?*]/g, "_");
      const filePath = path.join(this._persistDir, `${safeId}.json`);
      const data = {
        id: checkpoint.id, timestamp: checkpoint.timestamp, chatId: checkpoint.chatId,
        messageIndex: checkpoint.messageIndex, committed: checkpoint.committed, seq: checkpoint.seq,
        operations: checkpoint.operations,
        snapshots: checkpoint.snapshots.map((s) => ({
          absPath: s.absPath, existed: s.existed,
          contentLength: s.originalContent?.length ?? 0,
          originalContent: s.originalContent, encoding: s.encoding ?? "base64",
        })),
      };
      const tmpPath = `${filePath}.tmp_${process.pid}`;
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
      fs.renameSync(tmpPath, filePath);
    } catch (e) { console.warn(`[FileCheckpoint] 持久化写入失败: ${e}`); }
  }

  _deleteFromDisk(id) {
    if (!this._persistDir) return;
    try {
      const safeId = id.replace(/[<>:"/\\|?*]/g, "_");
      const filePath = path.join(this._persistDir, `${safeId}.json`);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch { /* ignore */ }
  }

  _loadFromDisk() {
    if (!this._persistDir || !fs.existsSync(this._persistDir)) return;
    try {
      const files = fs.readdirSync(this._persistDir).filter((f) => f.endsWith(".json"));
      for (const file of files) {
        try {
          const raw = fs.readFileSync(path.join(this._persistDir, file), "utf-8");
          const data = JSON.parse(raw);
          if (!data.id || !data.timestamp) continue;
          this._checkpoints.set(data.id, {
            id: data.id, timestamp: data.timestamp, chatId: data.chatId || "",
            messageIndex: data.messageIndex ?? -1, committed: data.committed ?? true,
            seq: typeof data.seq === "number" ? data.seq : 0,
            operations: data.operations || [],
            snapshots: (data.snapshots || []).map((s) => ({
              absPath: s.absPath, existed: s.existed,
              originalContent: s.originalContent ?? null,
              encoding: s.encoding ?? "utf-8",
            })),
          });
        } catch { try { fs.unlinkSync(path.join(this._persistDir, file)); } catch { /* ignore */ } }
      }
      if (this._checkpoints.size > 0) {
        let maxSeq = -1;
        for (const cp of this._checkpoints.values()) { if (cp.seq > maxSeq) maxSeq = cp.seq; }
        this._seqCounter = maxSeq + 1;
      }
    } catch (e) { console.warn(`[FileCheckpoint] 磁盘加载失败: ${e}`); }
  }

  _pruneOldCheckpoints() {
    if (this._checkpoints.size <= FileCheckpoint.MAX_CHECKPOINTS) return;
    const all = Array.from(this._checkpoints.values()).sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    const excess = all.length - FileCheckpoint.MAX_CHECKPOINTS;
    for (let i = 0; i < excess; i++) {
      this._deleteFromDisk(all[i].id);
      this._checkpoints.delete(all[i].id);
    }
  }
}

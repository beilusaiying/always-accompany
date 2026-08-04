/**
 * FileCheckpoint.ts — 文件操作快照系统（IDE 工具闭环 10 跳中的 Hop 6 节点）。
 * 不管工具执行逻辑（那是 ToolExecutor 的事），不管 WS 协议（那是 IdeWsServer 的事）。
 *
 * 链路：ToolExecutor 写工具 → snapshotBeforeWrite(写前) → recordOperation → commit(写完)
 *        回档时：ideClient revertToMessage → _checkpoint_revert_to_message → revertToMessage(LIFO)
 * 影响：
 *   - 内存 Map<id, Checkpoint> 存检查点（快照+操作记录）
 *   - 磁盘 .beilu/checkpoints/*.json 持久化（commit 时写盘，revert 时删盘）
 *   - revert 时原子写盘恢复文件（_atomicWriteFileSync：tmp→rename，Windows 杀软重试）
 *   - revert 时删除 AI 新建的文件 + 递归清理空目录
 * 相交：
 *   ← ToolExecutor.ts（写工具自动调 snapshotBeforeWrite/recordOperation/commit）
 *   ← ToolExecutor.ts execute（审批路径通过 pinTarget/unpinTarget 钉住快照目标）
 *   ← ideClient.mjs（通过 _checkpoint_* 内部工具间接调用 start/commit/revert/revertToMessage）
 *
 * 两条路径对比：
 *   常规路径：start(deferred=false) 抢占 _activeId → 写 → commit（一轮一检查点）
 *   审批路径：start(deferred=true) 只登记不抢占 → 挂起 → 用户批准 → pinTarget → 写 → _maybeCommitCheckpoint
 *     原因：审批挂起期间可能有其他轮 start，若抢占 _activeId 会导致快照落错检查点
 *
 * 参考 KiloCode 的 Snapshot 设计思路，区别在于不依赖 git，直接内存保存文件原始内容（base64 二进制安全）。
 */
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

/**
 * FileCheckpoint -- 文件操作快照系统（IDE 工具闭环 10 跳中的 Hop 6 节点）。
 * 不管工具执行逻辑（那是 ToolExecutor 的事），不管 WS 协议（那是 IdeWsServer 的事）。
 *
 * 链路：ToolExecutor 写工具 → snapshotBeforeWrite(写前) → recordOperation → commit(写完)
 *        回档时：ideClient revertToMessage → _checkpoint_revert_to_message → revertToMessage(LIFO)
 * 影响：
 *   - 内存 Map<id, Checkpoint> 存检查点（快照+操作记录）
 *   - 磁盘 .beilu/checkpoints/*.json 持久化（commit 时写盘，revert 时删盘）
 *   - revert 时原子写盘恢复文件（_atomicWriteFileSync：tmp→rename，Windows 杀软重试）
 *   - revert 时删除 AI 新建的文件 + 递归清理空目录
 * 相交：
 *   ← ToolExecutor.ts（写工具自动调 snapshotBeforeWrite/recordOperation/commit）
 *   ← ToolExecutor.ts execute（审批路径通过 pinTarget/unpinTarget 钉住快照目标）
 *   ← ideClient.mjs（通过 _checkpoint_* 内部工具间接调用 start/commit/revert/revertToMessage）
 *
 * 两条路径对比：
 *   常规路径：start(deferred=false) 抢占 _activeId → 写 → commit（一轮一检查点）
 *   审批路径：start(deferred=true) 只登记不抢占 → 挂起 → 用户批准 → pinTarget → 写 → _maybeCommitCheckpoint
 *     原因：审批挂起期间可能有其他轮 start，若抢占 _activeId 会导致快照落错检查点
 *
 * 参考 KiloCode 的 Snapshot 设计思路，区别在于不依赖 git，直接内存保存文件原始内容（base64 二进制安全）。
 */

/** 单个文件的快照 */
interface FileSnapshot {
  /** 文件绝对路径 */
  absPath: string;
  /** 文件在快照时是否已存在 */
  existed: boolean;
  /** 文件原始内容（base64 编码，不存在时为 null）。二进制安全：避免 utf-8 读写损坏非文本文件 */
  originalContent: string | null;
  /** originalContent 的编码。新快照恒为 base64；旧持久化数据缺省按 utf-8 兼容回放 */
  encoding?: "base64" | "utf-8";
}

/** 单个操作记录（供溯源） */
interface OperationRecord {
  tool: string;
  params: Record<string, unknown>;
  timestamp: string;
  /** 改动来源：ai=AI 工具调用所写；human=快照后被外部/人工改动（G-5 作者标记） */
  author?: "ai" | "human";
}

/** 一个检查点 */
interface Checkpoint {
  id: string;
  timestamp: string;
  chatId: string;
  messageIndex: number;
  /** 关联消息的稳定 ID；messageIndex 仅作为旧数据/排序兼容字段 */
  messageId?: string;
  /** 被修改文件的原始快照 */
  snapshots: FileSnapshot[];
  /** AI 的操作记录（溯源用） */
  operations: OperationRecord[];
  /** 是否已完成（防止重复添加） */
  committed: boolean;
  /** 单调创建序号。同 messageIndex 检查点排序的主依据：timestamp 毫秒级会撞（同一轮多次写 <1ms），seq 不会 */
  seq: number;
}

/**
 * 检查点管理器
 *
 * 生命周期：
 * 1. start(id, chatId, msgIndex) — AI 开始执行文件操作前调用
 * 2. snapshotBeforeWrite(path) — 每次写操作前自动调用
 * 3. recordOperation(tool, params) — 记录操作
 * 4. commit(id) — AI 操作完成后调用
 * 5. revert(id) — 回档时调用，恢复所有文件
 */
export class FileCheckpoint {
  /** 检查点存储 (id → Checkpoint) */
  private _checkpoints = new Map<string, Checkpoint>();

  /** 当前活跃的检查点 ID */
  private _activeId: string | null = null;

  /**
   * 显式快照目标（钉住）。审批写操作执行时由 ToolExecutor.execute 按 params._checkpointId 钉住，
   * 使快照落到该写操作真正归属的检查点，而非可能已被后续 start 劫持的全局 _activeId。
   * 优先级高于 _activeId；执行完毕在 finally 中解钉。
   */
  private _pinnedId: string | null = null;

  /** 单调递增的检查点创建序号源，用于同 messageIndex 平局时的确定性排序（毫秒时间戳会撞） */
  private _seqCounter = 0;

  /** 最大保留检查点数 */
  private static MAX_CHECKPOINTS = 50;

  /** 持久化目录 */
  private _persistDir: string | null = null;

  constructor() {
    try {
      const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (wsRoot) {
        this._persistDir = path.join(wsRoot, ".beilu", "checkpoints");
        if (!fs.existsSync(this._persistDir)) {
          fs.mkdirSync(this._persistDir, { recursive: true });
        }
        this.loadFromDisk();
      }
    } catch (e) {
      console.warn(`[FileCheckpoint] 持久化初始化失败，降级为纯内存模式: ${e}`);
      this._persistDir = null;
    }
  }

  /** 获取工作区根目录 */
  private getWorkspaceRoot(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
  }

  /** 将相对路径解析为绝对路径 */
  private resolveWorkspacePath(relPath: string): string {
    if (path.isAbsolute(relPath)) return relPath;
    return path.join(this.getWorkspaceRoot(), relPath);
  }

  /**
   * 开始一个新检查点。
   *
   * 影响：
   *   - 非 deferred：auto-commit 既有活跃检查点 + 设 _activeId + 环形缓冲裁剪
   *   - deferred：只登记，不抢占 _activeId（审批路径用 pinTarget 落快照）
   * 约束：已存在的 id 不重建（避免重复 start 清空已有快照）
   *
   * @param id 检查点 ID（建议 chatId_msgIndex_timestamp 格式）
   * @param chatId 关联的聊天 ID
   * @param messageIndex 关联的消息索引（回档时按此比较 > targetIndex）
   * @param deferred true=审批路径（不抢占、不 auto-commit），false=即时路径
   */
  start(
    id: string,
    chatId: string,
    messageIndex: number,
    deferred = false,
    messageId?: string,
  ): void {
    // deferred（审批路径）：只登记检查点，不抢占全局 _activeId，也不 auto-commit 既有活跃检查点。
    // 原因：审批写操作会在用户稍后批准时才执行，期间可能有其他轮 start。若此处设 _activeId 或
    // auto-commit，会导致挂起的审批检查点被劫持/提前提交，批准的写快照落错检查点 → 回档丢文件。
    // 审批写靠 ToolExecutor 钉住的显式 _checkpointId 落快照（见 _resolveTargetId）。
    if (!deferred && this._activeId && this._activeId !== id) {
      // 非审批路径：如果已有别的活跃检查点，先提交
      const previousActiveId = this._activeId;
      const commitResult = this.commit(previousActiveId);
      if (!commitResult.success) {
        throw new Error(
          `无法开始检查点 ${id}：旧检查点 ${previousActiveId} 提交失败：${commitResult.error || "未知错误"}`,
        );
      }
    }

    // 创建新检查点（已存在则保留，避免重复 start 清空快照）
    if (!this._checkpoints.has(id)) {
      this._checkpoints.set(id, {
        id,
        timestamp: new Date().toISOString(),
        chatId,
        messageIndex,
        messageId,
        snapshots: [],
        operations: [],
        committed: false,
        seq: this._seqCounter++,
      });
    }
    if (!deferred) this._activeId = id;

    // 环形缓冲：超过上限删除最旧的
    this.pruneOldCheckpoints();

    console.log(
      `[FileCheckpoint] 开始检查点: ${id} (chatId=${chatId}, msgIdx=${messageIndex}, deferred=${deferred})`,
    );
  }

  /** 钉住显式快照目标（审批写操作执行期间） */
  pinTarget(id: string): void {
    this._pinnedId = id;
  }

  /** 解钉显式快照目标 */
  unpinTarget(): void {
    this._pinnedId = null;
  }

  /**
   * 解析当前快照应落入的检查点 ID。
   * 钉住的显式目标（且存在、未提交）优先于全局 _activeId。
   */
  private _resolveTargetId(): string | null {
    if (this._pinnedId) {
      const pinned = this._checkpoints.get(this._pinnedId);
      if (pinned && !pinned.committed) return this._pinnedId;
    }
    return this._activeId;
  }

  /**
   * 在写操作前快照文件（自动去重）
   * 由 ToolExecutor 的 write_file / replace_lines / insert_at_line / fuzzy_edit 自动调用
   *（fuzzy_edit 的三种匹配策略分支均会各自调用一次，去重逻辑保证同文件只快照最早状态）
   *
   * @param filePath 文件路径（相对或绝对）
   */
  snapshotBeforeWrite(filePath: string): void {
    const targetId = this._resolveTargetId();
    if (!targetId) return;
    const checkpoint = this._checkpoints.get(targetId);
    if (!checkpoint || checkpoint.committed) return;

    const absPath = this.resolveWorkspacePath(filePath);

    // 去重：同一个检查点内同一文件只快照一次（保留最早的原始状态）
    if (checkpoint.snapshots.some((s) => s.absPath === absPath)) {
      return;
    }

    let existed = false;
    let originalContent: string | null = null;

    try {
      if (fs.existsSync(absPath)) {
        const stat = fs.statSync(absPath);
        if (!stat.isFile()) {
          throw new Error("目标已存在但不是普通文件");
        }
        existed = true;
        // 二进制安全：读为 Buffer 再 base64，避免 utf-8 把非文本字节替换成 U+FFFD
        originalContent = fs.readFileSync(absPath).toString("base64");
      }
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      // 写前快照不是可选日志：无法证明原文件内容时必须阻断写入，不能伪装成“原文件不存在”。
      throw new Error(`无法为写操作创建安全快照: ${absPath}: ${reason}`);
    }

    checkpoint.snapshots.push({
      absPath,
      existed,
      originalContent,
      encoding: "base64",
    });

    console.log(
      `[FileCheckpoint] 已快照: ${filePath} (existed=${existed}, size=${originalContent?.length ?? 0})`,
    );
  }

  /**
   * 记录操作（供溯源）
   * @param tool 工具名称
   * @param params 工具参数
   */
  recordOperation(tool: string, params: Record<string, unknown>): void {
    const targetId = this._resolveTargetId();
    if (!targetId) return;
    const checkpoint = this._checkpoints.get(targetId);
    if (!checkpoint || checkpoint.committed) return;

    checkpoint.operations.push({
      tool,
      params: { ...params },
      timestamp: new Date().toISOString(),
      author: "ai",
    });
  }

  /**
   * 提交检查点（标记完成，持久化到磁盘）。
   *
   * 影响：committed=true + 清 _activeId(如果是当前活跃) + saveToDisk 持久化到 .beilu/checkpoints/
   * 约束：commit 后的检查点不再接受 snapshotBeforeWrite/recordOperation
   */
  commit(id: string): { success: boolean; persisted: boolean; error?: string; warning?: string } {
    const checkpoint = this._checkpoints.get(id);
    if (!checkpoint) {
      return { success: false, persisted: false, error: `检查点不存在: ${id}` };
    }
    const previousCommitted = checkpoint.committed;
    const wasActive = this._activeId === id;
    // saveToDisk 需要把 committed=true 写入记录；若保存失败，下方恢复内存事务前状态。
    checkpoint.committed = true;
    const persistence = this.saveToDisk(checkpoint);
    if (!persistence.success) {
      checkpoint.committed = previousCommitted;
      if (wasActive) this._activeId = id;
      return persistence;
    }
    if (wasActive) this._activeId = null;
    console.log(
      `[FileCheckpoint] 已提交: ${id} (${checkpoint.snapshots.length}个文件, ${checkpoint.operations.length}个操作)`,
    );
    return persistence;
  }

  /**
   * 回档：恢复检查点中所有文件到原始状态。
   *
   * - 文件原来存在 → _atomicWriteFileSync 恢复原始内容（tmp→rename 原子写，Windows 杀软重试最多 5 次）
   * - 文件原来不存在（AI 新建的） → 删除文件 + 递归清理空目录
   *
   * 影响：从内存和磁盘删除该检查点 + 清理悬空 _activeId/_pinnedId 指针
   * 约束：revert 后检查点不可再用（已从 Map 删除）
   *
   * @param id 检查点 ID
   * @returns { success, restored, deleted, errors, failedFiles }
   */
  revert(
    id: string,
  ): {
    success: boolean;
    restored: number;
    deleted: number;
    errors: string[];
    failedFiles: string[];
  } {
    const checkpoint = this._checkpoints.get(id);
    if (!checkpoint) {
      return { success: false, restored: 0, deleted: 0, errors: [`检查点不存在: ${id}`], failedFiles: [] };
    }

    let restored = 0;
    let deleted = 0;
    const errors: string[] = [];
    const failedFiles: string[] = [];

    for (const snapshot of checkpoint.snapshots) {
      try {
        if (snapshot.existed) {
          if (typeof snapshot.originalContent !== "string") {
            throw new Error("检查点损坏：原文件存在但快照内容缺失");
          }
          // 文件原来存在 → 恢复原始内容
          const dir = path.dirname(snapshot.absPath);
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }
          // 按快照编码回写：base64 解码成 Buffer（二进制精确），旧 utf-8 数据按文本回放
          if (snapshot.encoding === "base64") {
            this._atomicWriteFileSync(snapshot.absPath, Buffer.from(snapshot.originalContent, "base64"));
          } else {
            this._atomicWriteFileSync(snapshot.absPath, snapshot.originalContent);
          }
          restored++;
          console.log(`[FileCheckpoint] 恢复: ${snapshot.absPath}`);
        } else {
          // 文件原来不存在 → 删除
          if (fs.existsSync(snapshot.absPath)) {
            fs.unlinkSync(snapshot.absPath);
            deleted++;
            console.log(`[FileCheckpoint] 删除(AI新建): ${snapshot.absPath}`);

            // 尝试清理空目录（向上递归）
            this.cleanEmptyDirs(path.dirname(snapshot.absPath));
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${snapshot.absPath}: ${msg}`);
        failedFiles.push(snapshot.absPath);
      }
    }

    // 只有所有文件恢复成功且持久化记录也删除成功，才消费该检查点。
    // 失败时保留记录，让重试从同一个完整快照重新执行，不会跳过失败点走向中间态。
    if (errors.length === 0) {
      const deleteError = this.deleteFromDisk(id);
      if (deleteError) errors.push(deleteError);
    }
    if (errors.length === 0) {
      this._checkpoints.delete(id);
      // 清理悬空指针：若被回档的检查点恰是当前活跃/钉住目标，置空，避免后续 snapshotBeforeWrite 取到已删检查点而静默丢快照
      if (this._activeId === id) this._activeId = null;
      if (this._pinnedId === id) this._pinnedId = null;
    }
    console.log(
      `[FileCheckpoint] 回档${errors.length === 0 ? "完成" : "失败并保留检查点"}: ${id} (恢复${restored}个, 删除${deleted}个, 错误${errors.length}个)`,
    );

    return { success: errors.length === 0, restored, deleted, errors, failedFiles };
  }

  /** 原子写盘:写临时文件→rename(同卷原子),失败清 tmp 再抛(交上层 errors 聚合)。避免 in-place 写盘崩在中途留半截文件破坏回档原文。 */
  private _atomicWriteFileSync(absPath: string, data: Buffer | string): void {
    const tmp = `${absPath}.beilu-revert-${process.pid}-${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmp, data);
      // Windows 杀软/索引器瞬时锁目标致 EPERM/EBUSY/EACCES → 同步小睡重试(对齐本体 renameSyncWithRetry),
      // 否则单次 renameSync 瞬时失败会让回档误报失败(对 IDE 内打开/被监控的文件尤其高发)。
      for (let i = 0; ; i++) {
        try { fs.renameSync(tmp, absPath); break; }
        catch (e: unknown) {
          const code = (e as { code?: string } | null)?.code;
          const transient = code === "EPERM" || code === "EBUSY" || code === "EACCES";
          if (!transient || i >= 4) throw e;
          try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); } catch { /* SAB 不可用则不睡,直接下次重试 */ }
        }
      }
    } catch (e) {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* 清理尽力而为 */ }
      throw e;
    }
  }

  /**
   * 查找适合回档的检查点
   * 逻辑：找到 chatId 匹配且 messageIndex <= targetIndex 的最新检查点
   */
  findForRollback(chatId: string, targetIndex: number): Checkpoint | null {
    const candidates: Checkpoint[] = [];
    for (const cp of this._checkpoints.values()) {
      if (cp.chatId === chatId && cp.messageIndex <= targetIndex) {
        candidates.push(cp);
      }
    }
    if (candidates.length === 0) return null;
    // 取 messageIndex 最大的（最接近目标的）
    candidates.sort((a, b) => b.messageIndex - a.messageIndex);
    return candidates[0];
  }

  /** 回档选择与排序的单一权威，preview / execute 必须复用，避免集合或顺序漂移。 */
  private _selectRollbackCheckpoints(chatId: string, targetIndex: number): Checkpoint[] {
    const selected = Array.from(this._checkpoints.values()).filter(
      (cp) => cp.chatId === chatId && cp.messageIndex > targetIndex,
    );
    selected.sort(
      (a, b) =>
        b.messageIndex - a.messageIndex ||
        b.seq - a.seq ||
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime() ||
        (a.id === b.id ? 0 : a.id < b.id ? 1 : -1),
    );
    return selected;
  }

  private static _sameCheckpointIds(actual: string[], expected: string[]): boolean {
    return actual.length === expected.length && actual.every((id, index) => id === expected[index]);
  }

  /**
   * 回档到指定消息：恢复 messageIndex > targetIndex 的所有检查点（R6 回档链路核心）。
   *
   * 排序：messageIndex 降序 → seq 降序 → timestamp 降序（LIFO，最旧检查点最后 revert）。
   * 原因：同一文件被多个检查点快照时，最后 revert 的快照（最早原始态）最终落地，
   *   否则停在中间态。seq 是单调创建序号，解决 timestamp 毫秒级碰撞。
   *
   * 影响：逐个调 revert() → 文件恢复/删除 + 检查点从内存和磁盘删除 + 清理悬空指针
   */
  revertToMessage(
    chatId: string,
    targetIndex: number,
    expectedCheckpointIds?: string[],
  ): {
    success: boolean;
    partial: boolean;
    checkpointSetDrift: boolean;
    attempted: number;
    reverted: number;
    checkpointsReverted: number;
    totalRestored: number;
    totalDeleted: number;
    errors: string[];
    failedFiles: string[];
    checkpointIds: string[];
    remainingCheckpointIds: string[];
  } {
    const toRevert = this._selectRollbackCheckpoints(chatId, targetIndex);
    const checkpointIds = toRevert.map((cp) => cp.id);
    if (expectedCheckpointIds && !FileCheckpoint._sameCheckpointIds(checkpointIds, expectedCheckpointIds)) {
      const error = "检查点集合已漂移；请重新预览后再回档";
      return {
        success: false,
        partial: false,
        checkpointSetDrift: true,
        attempted: 0,
        reverted: 0,
        checkpointsReverted: 0,
        totalRestored: 0,
        totalDeleted: 0,
        errors: [error],
        failedFiles: [],
        checkpointIds,
        remainingCheckpointIds: checkpointIds,
      };
    }

    let totalRestored = 0;
    let totalDeleted = 0;
    let attempted = 0;
    let reverted = 0;
    const allErrors: string[] = [];
    const allFailedFiles: string[] = [];

    for (const cp of toRevert) {
      attempted++;
      const result = this.revert(cp.id);
      totalRestored += result.restored;
      totalDeleted += result.deleted;
      allErrors.push(...result.errors);
      allFailedFiles.push(...result.failedFiles);
      if (!result.success) break;
      reverted++;
    }
    // 清理悬空指针
    if (this._activeId && !this._checkpoints.has(this._activeId)) this._activeId = null;
    if (this._pinnedId && !this._checkpoints.has(this._pinnedId)) this._pinnedId = null;

    console.log(
      `[FileCheckpoint] revertToMessage: chatId=${chatId}, targetIdx=${targetIndex}, ` +
        `attempted ${attempted}, reverted ${reverted}/${toRevert.length} checkpoints (restored ${totalRestored}, deleted ${totalDeleted})`,
    );

    const remainingCheckpointIds = this._selectRollbackCheckpoints(chatId, targetIndex).map((cp) => cp.id);
    const success = allErrors.length === 0 && reverted === toRevert.length;
    return {
      success,
      partial: !success && (reverted > 0 || totalRestored > 0 || totalDeleted > 0),
      checkpointSetDrift: false,
      attempted,
      reverted,
      checkpointsReverted: reverted,
      totalRestored,
      totalDeleted,
      errors: allErrors,
      failedFiles: allFailedFiles,
      checkpointIds,
      remainingCheckpointIds,
    };
  }

  /**
   * 只读预览：若回档到 targetIndex，文件会发生什么变化。
   * 复用 revertToMessage 的检查点选择 + revert 的 existed 判定，但绝不写磁盘。
   * - existed && originalContent 为字符串 → 该文件会被「还原」(filesToRestore)
   * - existed=false                       → 该文件会被「删除」(filesToDelete)
   * - existed=true 但内容缺失              → 检查点损坏，预览失败并阻断回档
   * 同一文件被多个检查点快照时，按 revert 实际执行顺序后写覆盖，与最终磁盘态一致。
   */
  getRevertToMessageDiff(
    chatId: string,
    targetIndex: number,
    expectedCheckpointIds?: string[],
  ): {
    success: boolean;
    checkpointSetDrift: boolean;
    error?: string;
    checkpointsToRevert: number;
    checkpointIds: string[];
    filesToRestore: string[];
    filesToDelete: string[];
  } {
    const toRevert = this._selectRollbackCheckpoints(chatId, targetIndex);
    const checkpointIds = toRevert.map((cp) => cp.id);
    if (expectedCheckpointIds && !FileCheckpoint._sameCheckpointIds(checkpointIds, expectedCheckpointIds)) {
      return {
        success: false,
        checkpointSetDrift: true,
        error: "检查点集合已漂移；请重新预览",
        checkpointsToRevert: toRevert.length,
        checkpointIds,
        filesToRestore: [],
        filesToDelete: [],
      };
    }

    const corruptSnapshots = toRevert
      .flatMap((cp) => cp.snapshots)
      .filter((snapshot) => snapshot.existed && typeof snapshot.originalContent !== "string");
    if (corruptSnapshots.length > 0) {
      return {
        success: false,
        checkpointSetDrift: false,
        error: `检查点损坏：${corruptSnapshots.length} 个原文件缺少快照内容，请勿执行回档`,
        checkpointsToRevert: toRevert.length,
        checkpointIds,
        filesToRestore: [],
        filesToDelete: [],
      };
    }

    const verdict = new Map<string, "restore" | "delete">();
    for (const cp of toRevert) {
      for (const snapshot of cp.snapshots) {
        if (snapshot.existed) {
          verdict.set(snapshot.absPath, "restore");
        } else {
          verdict.set(snapshot.absPath, "delete");
        }
      }
    }

    const filesToRestore: string[] = [];
    const filesToDelete: string[] = [];
    for (const [absPath, v] of verdict) {
      if (v === "restore") filesToRestore.push(absPath);
      else filesToDelete.push(absPath);
    }

    return {
      success: true,
      checkpointSetDrift: false,
      checkpointsToRevert: toRevert.length,
      checkpointIds,
      filesToRestore,
      filesToDelete,
    };
  }

  /**
   * 获取检查点的操作记录（溯源）
   */
  getOperations(id: string): OperationRecord[] | null {
    const checkpoint = this._checkpoints.get(id);
    if (!checkpoint) return null;
    return [...checkpoint.operations];
  }

  /**
   * 逐行 diff：对检查点内每个被改文件，比较「快照原始内容」vs「当前磁盘内容」，
   * 产出逐行红删(del)/绿增(add)/上下文(ctx) 行，供前端 diff 可视化。
   * 二进制文件（含 NUL 字节）标 binary、不逐行 diff。
   */
  getDiff(id: string): Array<{
    file: string;
    existed: boolean;
    binary: boolean;
    deletedNow: boolean;
    author: "ai" | "human";
    hunks: Array<{ type: "add" | "del" | "ctx"; oldLine: number | null; newLine: number | null; content: string }>;
  }> | null {
    const checkpoint = this._checkpoints.get(id);
    if (!checkpoint) return null;

    // G-5 作者归属：本检查点内 AI 操作触达过的文件 = ai 改；变了但无操作触达 = human/外部改。
    const _aiTouched = new Set<string>();
    for (const op of checkpoint.operations) {
      const p = op.params?.path;
      if (typeof p === "string" && p) _aiTouched.add(path.resolve(this.getWorkspaceRoot(), p));
      const ps = op.params?.paths;
      if (Array.isArray(ps)) for (const pp of ps) if (typeof pp === "string") _aiTouched.add(path.resolve(this.getWorkspaceRoot(), pp));
    }

    const decode = (s: string, enc?: "base64" | "utf-8"): Buffer =>
      enc === "base64" ? Buffer.from(s, "base64") : Buffer.from(s, "utf-8");
    const isBinary = (buf: Buffer): boolean => buf.includes(0);

    const result: Array<{
      file: string; existed: boolean; binary: boolean; deletedNow: boolean; author: "ai" | "human";
      hunks: Array<{ type: "add" | "del" | "ctx"; oldLine: number | null; newLine: number | null; content: string }>;
    }> = [];

    for (const snapshot of checkpoint.snapshots) {
      const rel = path.relative(this.getWorkspaceRoot(), snapshot.absPath).replace(/\\/g, "/");
      if (snapshot.existed && typeof snapshot.originalContent !== "string") {
        throw new Error(`检查点损坏：原文件存在但快照内容缺失: ${snapshot.absPath}`);
      }
      const oldBuf = snapshot.existed
        ? decode(snapshot.originalContent as string, snapshot.encoding)
        : Buffer.alloc(0);
      let newBuf = Buffer.alloc(0);
      let deletedNow = false;
      try {
        if (fs.existsSync(snapshot.absPath)) newBuf = fs.readFileSync(snapshot.absPath);
        else deletedNow = snapshot.existed;
      } catch {
        deletedNow = snapshot.existed;
      }
      const author: "ai" | "human" = _aiTouched.has(snapshot.absPath) ? "ai" : "human";
      const binary = isBinary(oldBuf) || isBinary(newBuf);
      if (binary) {
        result.push({ file: rel, existed: snapshot.existed, binary: true, deletedNow, author, hunks: [] });
        continue;
      }
      const oldLines = snapshot.existed ? oldBuf.toString("utf-8").split("\n") : [];
      const newLines = deletedNow ? [] : newBuf.toString("utf-8").split("\n");
      result.push({
        file: rel,
        existed: snapshot.existed,
        binary: false,
        deletedNow,
        author,
        hunks: FileCheckpoint._lineDiff(oldLines, newLines),
      });
    }
    return result;
  }

  /** LCS 逐行 diff：返回 del(仅旧)/add(仅新)/ctx(共有) 行序列。纯函数，确定性。 */
  private static _lineDiff(
    a: string[],
    b: string[],
  ): Array<{ type: "add" | "del" | "ctx"; oldLine: number | null; newLine: number | null; content: string }> {
    const n = a.length, m = b.length;
    // LCS 长度表
    const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
    const out: Array<{ type: "add" | "del" | "ctx"; oldLine: number | null; newLine: number | null; content: string }> = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        out.push({ type: "ctx", oldLine: i + 1, newLine: j + 1, content: a[i] });
        i++; j++;
      } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
        out.push({ type: "del", oldLine: i + 1, newLine: null, content: a[i] });
        i++;
      } else {
        out.push({ type: "add", oldLine: null, newLine: j + 1, content: b[j] });
        j++;
      }
    }
    while (i < n) { out.push({ type: "del", oldLine: i + 1, newLine: null, content: a[i] }); i++; }
    while (j < m) { out.push({ type: "add", oldLine: null, newLine: j + 1, content: b[j] }); j++; }
    return out;
  }

  /**
   * 检查溯源是否可行（文件是否与快照一致）
   */
  canReplay(id: string): { canReplay: boolean; changedFiles: string[] } {
    const checkpoint = this._checkpoints.get(id);
    if (!checkpoint) return { canReplay: false, changedFiles: [] };

    const changedFiles: string[] = [];
    for (const snapshot of checkpoint.snapshots) {
      try {
        if (!fs.existsSync(snapshot.absPath)) {
          // 文件被删了但快照时存在
          if (snapshot.existed) changedFiles.push(snapshot.absPath);
          continue;
        }
        // 用与快照相同的编码读取当前内容再比较，二进制文件不会误判
        const currentContent = snapshot.encoding === "base64"
          ? fs.readFileSync(snapshot.absPath).toString("base64")
          : fs.readFileSync(snapshot.absPath, "utf-8");
        if (snapshot.existed) {
          // 比较原始内容 — 如果和快照不同说明有手动修改
          if (currentContent !== snapshot.originalContent) {
            changedFiles.push(snapshot.absPath);
          }
        }
      } catch {
        changedFiles.push(snapshot.absPath);
      }
    }

    return { canReplay: changedFiles.length === 0, changedFiles };
  }

  /**
   * 列出所有检查点
   */
  list(): Array<{
    id: string;
    timestamp: string;
    chatId: string;
    messageIndex: number;
    messageId?: string;
    fileCount: number;
    opCount: number;
    committed: boolean;
  }> {
    return Array.from(this._checkpoints.values()).map((cp) => ({
      id: cp.id,
      timestamp: cp.timestamp,
      chatId: cp.chatId,
      messageIndex: cp.messageIndex,
      messageId: cp.messageId,
      fileCount: cp.snapshots.length,
      opCount: cp.operations.length,
      committed: cp.committed,
    }));
  }

  /**
   * 清理指定 chatId 在 targetIndex 之后的检查点
   */
  pruneAfter(chatId: string, targetIndex: number): number {
    let count = 0;
    for (const [id, cp] of this._checkpoints) {
      if (cp.chatId === chatId && cp.messageIndex > targetIndex) {
        this.deleteFromDisk(id);
        this._checkpoints.delete(id);
        count++;
      }
    }
    return count;
  }

  // ---- 内部辅助 ----

  /** 清理空目录（向上递归，遇到非空目录停止） */
  private cleanEmptyDirs(dir: string): void {
    const wsRoot = this.getWorkspaceRoot();
    try {
      // 安全检查：不超出工作区
      if (!path.resolve(dir).startsWith(path.resolve(wsRoot))) return;
      if (dir === wsRoot) return;

      const entries = fs.readdirSync(dir);
      if (entries.length === 0) {
        fs.rmdirSync(dir);
        // 递归清理上层
        this.cleanEmptyDirs(path.dirname(dir));
      }
    } catch {
      // 忽略
    }
  }

  // ---- 持久化 ----

  private saveToDisk(
    checkpoint: Checkpoint,
  ): { success: boolean; persisted: boolean; error?: string; warning?: string } {
    if (!this._persistDir) {
      return { success: true, persisted: false, warning: "当前为纯内存检查点模式，未持久化到磁盘" };
    }
    try {
      const safeId = checkpoint.id.replace(/[<>:"/\\|?*]/g, "_");
      const filePath = path.join(this._persistDir, `${safeId}.json`);
      const data = {
        id: checkpoint.id,
        timestamp: checkpoint.timestamp,
        chatId: checkpoint.chatId,
        messageIndex: checkpoint.messageIndex,
        messageId: checkpoint.messageId,
        committed: checkpoint.committed,
        seq: checkpoint.seq,
        operations: checkpoint.operations,
        snapshots: checkpoint.snapshots.map((s) => ({
          absPath: s.absPath,
          existed: s.existed,
          contentLength: s.originalContent?.length ?? 0,
          originalContent: s.originalContent,
          encoding: s.encoding ?? "base64",
        })),
      };
      const tmpPath = `${filePath}.tmp_${process.pid}`;
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
      fs.renameSync(tmpPath, filePath);
      return { success: true, persisted: true };
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      console.warn(`[FileCheckpoint] 持久化写入失败: ${error}`);
      return { success: false, persisted: false, error: `检查点持久化失败: ${error}` };
    }
  }

  private deleteFromDisk(id: string): string | null {
    if (!this._persistDir) return null;
    try {
      const safeId = id.replace(/[<>:"/\\|?*]/g, "_");
      const filePath = path.join(this._persistDir, `${safeId}.json`);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      return null;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[FileCheckpoint] 删除持久化检查点失败: ${id}: ${message}`);
      return `删除持久化检查点失败: ${id}: ${message}`;
    }
  }

  private loadFromDisk(): void {
    if (!this._persistDir || !fs.existsSync(this._persistDir)) return;
    try {
      const files = fs.readdirSync(this._persistDir).filter((f) => f.endsWith(".json"));
      for (const file of files) {
        try {
          const raw = fs.readFileSync(path.join(this._persistDir, file), "utf-8");
          const data = JSON.parse(raw);
          if (!data.id || !data.timestamp) continue;
          const checkpoint: Checkpoint = {
            id: data.id,
            timestamp: data.timestamp,
            chatId: data.chatId || "",
            messageIndex: data.messageIndex ?? -1,
            messageId: typeof data.messageId === "string" ? data.messageId : undefined,
            committed: data.committed ?? true,
            // 旧持久化无 seq → 0（平局回退 timestamp，与旧行为一致，不退化）
            seq: typeof data.seq === "number" ? data.seq : 0,
            operations: data.operations || [],
            snapshots: (data.snapshots || []).map((s: { absPath: string; existed: boolean; originalContent: string | null; encoding?: "base64" | "utf-8" }) => ({
              absPath: s.absPath,
              existed: s.existed,
              originalContent: s.originalContent ?? null,
              // 旧持久化数据无 encoding 字段 → 按 utf-8 兼容回放，不误解码成 base64
              encoding: s.encoding ?? "utf-8",
            })),
          };
          this._checkpoints.set(checkpoint.id, checkpoint);
        } catch {
          try { fs.unlinkSync(path.join(this._persistDir, file)); } catch { /* ignore */ }
        }
      }
      if (this._checkpoints.size > 0) {
        // 让新检查点的 seq 严格大于所有已加载的，避免跨重启 seq 复用导致同 messageIndex 排序错乱
        let maxSeq = -1;
        for (const cp of this._checkpoints.values()) {
          if (cp.seq > maxSeq) maxSeq = cp.seq;
        }
        this._seqCounter = maxSeq + 1;
        console.log(`[FileCheckpoint] 从磁盘加载了 ${this._checkpoints.size} 个检查点`);
      }
    } catch (e) {
      console.warn(`[FileCheckpoint] 磁盘加载失败: ${e}`);
    }
  }

  /** 环形缓冲：超过上限删除最旧的检查点 */
  private pruneOldCheckpoints(): void {
    if (this._checkpoints.size <= FileCheckpoint.MAX_CHECKPOINTS) return;
    // 按时间排序，删最旧的
    const all = Array.from(this._checkpoints.values()).sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
    const excess = all.length - FileCheckpoint.MAX_CHECKPOINTS;
    for (let i = 0; i < excess; i++) {
      this.deleteFromDisk(all[i].id);
      this._checkpoints.delete(all[i].id);
    }
  }
}

import { wbT, wbD } from "../../../../../server/wbStub.mjs";
/**
 * backgroundTasks.mjs — 后台归档任务（三层记忆 hot→warm→cold 自动搬迁与日终归档）。
 *
 * 【功能链】
 *   每轮 AI 回复结束后由 replyHandler 触发 autoCheckArchiveTriggers()，
 *   按阈值检查各层记忆是否需要搬迁：
 *     #3 完成任务 → hot/appointments.json
 *     #4 临时记忆溢出（≥50条）→ warm/{year}/{month}/{day}_details/batch_NNN.json
 *     #7 关于用户超龄（≥3天）→ hot/remember_about_user/{date}.json
 *     #8 永久记忆溢出（≥200条）→ hot/forever.json 按日期分批
 *     #9 warm 旧日记录（≥30天）→ cold/（温→冷，每天最多1次）
 *     code/work 经验表过大（≥80行）→ code/archive/ 或 work/archive/
 *   日终归档（endDay）在用户点击"结束今天"时触发，执行 9 步完整收尾流程（含 P2 总结）。
 *   不直接 import aiRunner（防循环依赖），P2 总结通过 callbacks.onTriggerP2 回调解耦触发。
 *
 * 【why】
 *   记忆体系分三温层（hot 活跃 / warm 近期 / cold 归档）是为了控制 GetPrompt 注入 token 量——
 *   只有 hot 层注入 AI，warm/cold 按需检索。三层搬迁必须自动化：
 *   若等用户手动归档，hot 层会无限增长导致每轮 token 超限。
 *   每轮检查（而非定时 cron）是因为记忆写入（tableEdit）发生在 replyHandler，
 *   在同一"回复处理链"尾部立即检查，可保证"写后即检"没有延迟窗口。
 *
 * 【前端调用方式】
 *   自动触发（无需前端操作）：
 *     generation.mjs → replyHandler.handleReply() → autoCheckArchiveTriggers()（每轮末尾）
 *   手动触发（用户操作）：
 *     前端点击"结束今天" → SetData("endDay") → setDataActions → endDay()
 *     → 9步日终归档（含 onTriggerP2 → aiRunner.triggerP2Summary）
 *   归档完成后前端无专用广播，但下轮 GetData 拉取时 tables 状态已更新（已归档行消失）。
 *
 * 【关联链】
 *   ← replyHandler.mjs（每轮末尾调 autoCheckArchiveTriggers）
 *   ← setDataActions.mjs（endDay 日终归档入口）
 *   → storage.mjs（loadMemoryData / saveTablesData / saveJsonFile / getMemoryDir / getTodayStr 等，唯一 lib 依赖）
 *   → callbacks.onTriggerP2（注册回调 → aiRunner.triggerP2Summary — 通过 main.mjs 注入，防循环依赖）
 *
 * 【影响范围】
 *   - 写 hot/remember_about_user/{date}.json（#7 按日期分组归档）
 *   - 写 hot/forever.json（#8 溢出归档）
 *   - 写 hot/appointments.json（#3 完成任务归档）
 *   - 写 warm/{year}/{month}/{day}_details/batch_NNN.json（#4 临时记忆归档）
 *   - 写 warm/{year}/{month}/{day}_summary.json（日终总结）
 *   - 写 hot/warm_monthly_index.json（月索引）
 *   - 移动 warm/ → cold/（温→冷归档，每天最多 1 次）
 *   - 写 code/archive/ 或 work/archive/（code/work 经验表瘦身）
 *   - 修改内存表（清空/删行），通过 saveTablesData 落盘
 *   - 不广播 WS 事件（归档是静默后台操作，前端感知通过下次 GetData 拉取）
 *
 * 【使用效果】
 *   hot 层记忆始终保持在合理规模（不超阈值），GetPrompt 注入 token 受控；
 *   历史记忆自动沉降到 warm/cold 层，按需由 P1 检索召回；
 *   日终归档后当天的对话/任务/关于用户记录完整保存，P2 总结生成当天摘要。
 *
 * 触发阈值均从 _config.json 读取（可配），各函数内部有兜底默认值：
 *   #4 temp_memory_threshold=50 / #7 remember_archive_days=3 / #8 forever_max=200 /
 *   #9 保留最近2天 / warm→cold cold_archive_after_days=30 / code/work total_rows_threshold=80
 */

import fs from "node:fs";
import path from "node:path";
import { createArchiveSnapshot } from "../../rollback/snapshot.mjs"; // 归档前自动快照（凛倾0712；rollback→storage 单向无环）
import { normalizeEntry } from "../storage_mod/memoryEntryFormat.mjs"; // 修9 20260716：归档写侧接入格式单源（框架本就设计"归档写入前规范化"，warm batch/行归档两写点原是半接线）

import {
  getActiveMode,
  getDaysAgoStr,
  getMemoryDir,
  getTodayStr,
  loadJsonFileIfExists,
  loadMemoryData,
  saveJsonFile,
  saveTablesData,
  withFileLock,
} from "../storage_mod/storage.mjs";


// ============================================================
// #7 归档：超过3天的条目移入 hot/remember_about_user/{date}.json
// ============================================================

/**
 * #7 归档：把超过 remember_archive_days 天的"关于用户"条目从表格移入 hot/remember_about_user/{date}.json。
 *
 * 链路：autoCheckArchiveTriggers / endDay Step5 → archiveRememberAboutUser → saveJsonFile + saveTablesData
 * 影响：写 hot/remember_about_user/{date}.json（按日期分组追加）、修改 table7.rows、落盘 saveTablesData
 * 约束：cutoff 日期从 config.archive.remember_archive_days 读取（未配回退 3 天）
 *
 * @param {string} username
 * @param {string} charName
 * @returns {{ archived: number }}
 */
export async function archiveRememberAboutUser(username, charName) {
  wbT(null, "backgroundTasks", "archiveRememberAboutUser:enter", { username, charName });
  // 修6（20260716）：#7 关于用户=chat 域固定表，强制 "chat"——原 2 参按会话 active_mode 加载，
  //   code/work 会话里点归档/endDay 会打开 code/work 表集找 id=7（表 id 跨模式撞车）=跨域搬错数据。
  //   同批：#8/#3/#4/#9/endDay 各函数同锚（域归属在函数定义层锚死，不靠调用方传对）。
  const data = loadMemoryData(username, charName, "chat");
  const table7 = data.tables.find((t) => t.id === 7);
  if (!table7 || table7.rows.length === 0) return { archived: 0 };

  // #7 归档年龄：config.archive.remember_archive_days 可配，未配回退 3 天（行为同旧，零回归）
  const remDays = data.config?.archive?.remember_archive_days || 3;
  const cutoffStr = getDaysAgoStr(remDays);
  const toArchive = [];
  const toKeep = [];

  for (const row of table7.rows) {
    const dateCol = row[0] || "";
    if (dateCol && dateCol < cutoffStr) {
      toArchive.push(row);
    } else {
      toKeep.push(row);
    }
  }

  if (toArchive.length === 0) return { archived: 0 };

  wbT(null, "backgroundTasks", "archiveRememberAboutUser:willArchive", { count: toArchive.length, cutoffStr });
  // 按日期分组归档
  const byDate = {};
  for (const row of toArchive) {
    const date = row[0] || getTodayStr();
    if (!byDate[date]) byDate[date] = [];
    byDate[date].push({
      thing: row[1] || "",
      reason: row[2] || "",
      date: date,
    });
  }

  const memDir = getMemoryDir(username, charName);
  const rememberDir = path.join(memDir, "hot", "remember_about_user");
  if (!fs.existsSync(rememberDir))
    fs.mkdirSync(rememberDir, { recursive: true });

  for (const [date, entries] of Object.entries(byDate)) {
    const filePath = path.join(rememberDir, `${date}.json`);
    const existing = loadJsonFileIfExists(filePath, { entries: [] });
    existing.entries = (existing.entries || []).concat(entries);
    saveJsonFile(filePath, existing);
  }

  table7.rows = toKeep;
  // T1：归档链 await 化——瘦身后落表从 fire-and-forget 改 await，写盘失败向上抛（不静默丢盘）。
  const _w7 = await saveTablesData(username, charName, data.activeMode);
  if (_w7 && _w7.ok === false) throw new Error(`archiveRememberAboutUser saveTablesData 失败: ${_w7.error}`);
  wbT(null, "backgroundTasks", "archiveRememberAboutUser:done", { archived: toArchive.length });
  console.log(
    `[beilu-memory] #7 归档了 ${toArchive.length} 条超过${remDays}天的记忆 (${charName})`,
  );
  return { archived: toArchive.length };
}

// ============================================================
// #8 归档：表格超过200条时，溢出条目移入 hot/forever.json
// ============================================================

/**
 * #8 归档：表格超过 forever_max 条时，溢出的旧条目移入 hot/forever.json（保留最新 forever_max 条）。
 *
 * 链路：autoCheckArchiveTriggers / endDay 尾步 → archiveForeverEntries → saveJsonFile + saveTablesData
 * 影响：写 hot/forever.json（追加 entries）、修改 table8.rows（截留最新）、落盘 saveTablesData
 *
 * @param {string} username
 * @param {string} charName
 * @returns {{ archived: number }}
 */
export async function archiveForeverEntries(username, charName) {
  wbT(null, "backgroundTasks", "archiveForeverEntries:enter", { username, charName });
  const data = loadMemoryData(username, charName, "chat"); // 修6：#8=chat 域固定表（判据同 archiveRememberAboutUser 注释）
  const table8 = data.tables.find((t) => t.id === 8);
  // #8 永久记忆上限：config.archive.forever_max 可配，未配回退 200（行为同旧，零回归）
  const foreverMax = data.config?.archive?.forever_max || 200;
  if (!table8 || table8.rows.length <= foreverMax) return { archived: 0 };

  const toKeep = table8.rows.slice(-foreverMax);
  const toArchive = table8.rows.slice(0, table8.rows.length - foreverMax);

  const memDir = getMemoryDir(username, charName);
  const foreverPath = path.join(memDir, "hot", "forever.json");
  const existing = loadJsonFileIfExists(foreverPath, { entries: [] });

  for (const row of toArchive) {
    existing.entries.push({
      event: row[0] || "",
      date: row[1] || getTodayStr(),
      weight: 1,
      last_triggered: new Date().toISOString(),
    });
  }
  wbT(null, "backgroundTasks", "archiveForeverEntries:saveFile", { path: foreverPath, count: toArchive.length });
  saveJsonFile(foreverPath, existing);

  table8.rows = toKeep;
  // T1：归档链 await 化——瘦身后落表从 fire-and-forget 改 await，写盘失败向上抛（不静默丢盘）。
  const _w8 = await saveTablesData(username, charName, data.activeMode);
  if (_w8 && _w8.ok === false) throw new Error(`archiveForeverEntries saveTablesData 失败: ${_w8.error}`);
  wbT(null, "backgroundTasks", "archiveForeverEntries:done", { archived: toArchive.length });
  console.log(
    `[beilu-memory] #8 归档了 ${toArchive.length} 条溢出记忆到 forever.json (${charName})`,
  );
  return { archived: toArchive.length };
}

// ============================================================
// forever.json 字段规范化：补全缺失的 weight / last_triggered
// ============================================================

/**
 * 旧版/AI直写的 forever 条目可能只有 event+date，
 * 缺 weight 和 last_triggered 会导致 Top-K 排序降级到 idx 估算。
 * 本函数一次性补全，后续由 autoCheckArchiveTriggers 周期调用。
 *
 * @param {string} username
 * @param {string} charName
 * @returns {{ normalized: number }}
 */
export function normalizeForeverEntries(username, charName) {
  const memDir = getMemoryDir(username, charName);
  const foreverPath = path.join(memDir, "hot", "forever.json");
  const data = loadJsonFileIfExists(foreverPath, { entries: [] });
  if (!data.entries || data.entries.length === 0) return { normalized: 0 };

  let count = 0;
  for (const entry of data.entries) {
    if (typeof entry !== "object" || entry === null) continue;
    if (entry.weight === undefined || entry.weight === null) {
      entry.weight = 1;
      count++;
    }
    if (!entry.last_triggered) {
      entry.last_triggered = entry.date
        ? new Date(entry.date + "T12:00:00").toISOString()
        : new Date().toISOString();
      count++;
    }
  }

  if (count > 0) {
    saveJsonFile(foreverPath, data);
    console.log(
      `[beilu-memory] forever.json 规范化了 ${count} 个缺失字段 (${charName})`,
    );
  }
  return { normalized: count };
}

// ============================================================
// #3 归档：已完成的任务移入 hot/appointments.json
// ============================================================

// 完成标记自判：显式收尾标记集（复用 setDataActions.mjs:2647 "单元格文本判完成态" 范式）。
// 仅匹配显式收尾符号/词，不含裸"完成"字，规避 未完成/待完成/完成度 等误判。
const COMPLETED_MARK_RE =
  /(?:✅|✔️?|【完成】|\[完成\]|（完成）|\(完成\)|已完成|已归档|\bdone\b|\[[xX]\])/;

/**
 * 后端自判：扫 table3 行内任一单元格的显式完成标记，返回完成行下标。
 * 单源——前端无 AI 语义判断能力，完成判据集中在后端一处。
 * @param {Array<Array<string>>} rows
 * @returns {number[]} 完成行的下标（升序）
 */
function detectCompletedRows(rows) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const text = Array.isArray(row) ? row.join(" ") : String(row ?? "");
    if (COMPLETED_MARK_RE.test(text)) out.push(i);
  }
  return out;
}

/**
 * #3 归档：已完成的任务从表格移入 hot/appointments.json。
 *
 * 链路：setDataActions("archiveCompletedTasks") / endDay Step6(目前跳过) → archiveCompletedTasks → saveJsonFile + saveTablesData
 * 影响：写 hot/appointments.json（追加 entries）、修改 table3.rows（splice 删除完成行）、落盘 saveTablesData
 * 约束：完成行按降序 splice（防索引偏移）；completedRowIndices 未传时后端 detectCompletedRows 自判（显式完成标记正则）
 *
 * @param {string} username
 * @param {string} charName
 * @param {number[]} [completedRowIndices] 可选；为空/未传时后端自扫 table3 完成标记
 * @returns {{ archived: number, scanned: number, autoDetected: boolean }}
 */
export async function archiveCompletedTasks(username, charName, completedRowIndices) {
  wbT(null, "backgroundTasks", "archiveCompletedTasks:enter", { username, charName, count: completedRowIndices?.length });
  const data = loadMemoryData(username, charName, "chat"); // 修6：#3=chat 域固定表（code #3=流程架构索引，id 撞车跨域实证；判据同 archiveRememberAboutUser 注释）
  const table3 = data.tables.find((t) => t.id === 3);
  if (!table3) return { archived: 0, scanned: 0, autoDetected: false };

  // 完成行下标：调用方传了非空数组→按下标走（向后兼容）；否则后端自判完成行。
  let rowIndices = Array.isArray(completedRowIndices) ? completedRowIndices : [];
  let autoDetected = false;
  if (rowIndices.length === 0) {
    autoDetected = true;
    rowIndices = detectCompletedRows(table3.rows);
    wbT(null, "backgroundTasks", "archiveCompletedTasks:autoDetect", { scanned: table3.rows.length, detected: rowIndices.length });
  }
  if (rowIndices.length === 0)
    return { archived: 0, scanned: table3.rows.length, autoDetected };

  const memDir = getMemoryDir(username, charName);
  const appointmentsPath = path.join(memDir, "hot", "appointments.json");
  const existing = loadJsonFileIfExists(appointmentsPath, { entries: [] });

  const scanned = table3.rows.length;
  const sorted = [...rowIndices].sort((a, b) => b - a);
  let archived = 0;

  for (const idx of sorted) {
    if (idx >= 0 && idx < table3.rows.length) {
      const row = table3.rows[idx];
      existing.entries.push({
        character: row[0] || "",
        task: row[1] || "",
        location: row[2] || "",
        duration: row[3] || "",
        completed_at: new Date().toISOString(),
      });
      table3.rows.splice(idx, 1);
      archived++;
    }
  }

  if (archived > 0) {
    wbT(null, "backgroundTasks", "archiveCompletedTasks:saveFile", { path: appointmentsPath, archived });
    saveJsonFile(appointmentsPath, existing);
    // T1：归档链 await 化——瘦身后落表从 fire-and-forget 改 await，写盘失败向上抛（不静默丢盘）。
    const _w3 = await saveTablesData(username, charName, data.activeMode);
    if (_w3 && _w3.ok === false) throw new Error(`archiveCompletedTasks saveTablesData 失败: ${_w3.error}`);
    wbT(null, "backgroundTasks", "archiveCompletedTasks:done", { archived });
    console.log(
      `[beilu-memory] #3 归档了 ${archived} 个已完成任务 (${charName})`,
    );
  }
  return { archived, scanned, autoDetected };
}

// ============================================================
// #4 临时记忆归档：超过阈值时归档到 warm 层
// ============================================================

/**
 * #4 临时记忆归档：全部行按 10 条一批写入 warm/{year}/{month}/{day}_details/batch_NNN.json，清空表格。
 *
 * 链路：autoCheckArchiveTriggers(rows > threshold) / endDay Step7 → archiveTempMemory → saveJsonFile + saveTablesData
 * 影响：写 warm/{y}/{m}/{d}_details/batch_NNN.json（每批 10 条）、清空 table4.rows、落盘 saveTablesData
 * 约束：threshold 从 config.archive.temp_memory_threshold 读取（未配回退 50）；归档后由 autoCheckArchiveTriggers 异步触发 P2 总结 AI
 *
 * @param {string} username
 * @param {string} charName
 * @returns {{ archived: number, batchFiles: string[] }}
 */
export async function archiveTempMemory(username, charName, chatId) {
  // 修6（20260716）覆盖 T4 同族深修（07-03）：#4 临时记忆=chat 域固定表，mode 直接锚 "chat"。
  //   T4 当年把「load 全局 active_mode」修成「per-chatId active_mode」——读写同源了，但域还是跟着会话漂：
  //   code/work 会话触发时打开 code/work 表集找 id=4（错-经验表撞车）=跨域搬错数据。域归属在函数定义层
  //   锚死后 chatId 对 chat 裸缓存键无消费（保参数形状，兼容既有调用方）。
  wbT(chatId || null, "backgroundTasks", "archiveTempMemory:enter", { username, charName, chatId });
  const data = loadMemoryData(username, charName, "chat", chatId);
  const table4 = data.tables.find((t) => t.id === 4);
  const config = data.config;
  const threshold = config?.archive?.temp_memory_threshold || 50;

  if (!table4 || table4.rows.length <= threshold)
    return { archived: 0, batchFiles: [] };

  const today = getTodayStr();
  const [year, month, day] = today.split("-");

  const memDir = getMemoryDir(username, charName);
  const detailsDir = path.join(memDir, "warm", year, month, `${day}_details`);
  if (!fs.existsSync(detailsDir)) fs.mkdirSync(detailsDir, { recursive: true });

  // 找到已有的最大 batch 编号
  let maxBatch = 0;
  if (fs.existsSync(detailsDir)) {
    const existing = fs
      .readdirSync(detailsDir)
      .filter((f) => f.startsWith("batch_"));
    for (const f of existing) {
      const num = parseInt(f.replace("batch_", "").replace(".json", ""), 10);
      if (num > maxBatch) maxBatch = num;
    }
  }

  // T4 同族半修补齐（07-03）：本函数头注释声称 chatId 穿透 getActiveMode，但此处原漏传——
  // 批次文件 _mode 标签（:404）会错标成全局模式。load(:350)/save(:414) 已 per-chatId，此处对齐；
  // endDay 线传 undefined=char 级回退零漂移（:347 既有裁决）。
  const activeMode = getActiveMode(username, charName, chatId) || "chat";
  const columns = table4.columns || [];
  const allRows = [...table4.rows];
  const batchFiles = [];
  let batchNum = maxBatch;

  for (let i = 0; i < allRows.length; i += 10) {
    batchNum++;
    const batch = allRows.slice(i, i + 10);
    const batchEntries = batch.map((row) => {
      const entry = { archived_at: new Date().toISOString() };
      if (columns.length > 0) {
        for (let c = 0; c < columns.length; c++) {
          entry[columns[c]] = row[c] || "";
        }
        // 修9（凛倾 20260716「前面是关键词+时间，后面是内容」）：任意列名条目 normalizeEntry 的
        //   content 兜底链（event/task/character）必然 miss → content 空、keywords 空分词=P1 召回死条目。
        //   写侧给 content=行值拼接（纯内容不混列名），标准头交 normalizeEntry 补齐+排序。
        entry.content = row.filter(Boolean).join(" · ");
      } else {
        entry.character = row[0] || "";
        entry.event = row[1] || "";
        entry.date = row[2] || today;
        entry.location = row[3] || "";
        entry.emotion = row[4] || "";
      }
      return normalizeEntry(entry, "warm");
    });
    const batchFile = `batch_${String(batchNum).padStart(3, "0")}.json`;
    saveJsonFile(path.join(detailsDir, batchFile), {
      _source_table: table4.name || `#${table4.id}`,
      _mode: activeMode,
      _columns: columns,
      entries: batchEntries,
    });
    batchFiles.push(batchFile);
  }

  const archivedCount = table4.rows.length;
  wbT(null, "backgroundTasks", "archiveTempMemory:saveBatch", { detailsDir, batchCount: batchFiles.length, archivedCount });
  table4.rows = [];
  // T1：归档链 await 化——瘦身后落表从 fire-and-forget 改 await，写盘失败向上抛（不静默丢盘）。
  const _w4 = await saveTablesData(username, charName, data.activeMode, chatId); // T4 同族：四参防写错（per-chatId ctx 表优先）
  if (_w4 && _w4.ok === false) throw new Error(`archiveTempMemory saveTablesData 失败: ${_w4.error}`);

  // 月索引同步（凛倾0712系统排查）：原索引只在 endDay Step8 更新——只走 P2 归档没点"结束今天"的日子
  // 不进 days_with_data，AI 注入的"历史记忆索引"漏报该天有数据（检索走全盘扫不受影响，纯显示层漂移）。
  // 与 endDay Step8 同结构幂等（includes 判重），失败不阻断归档主流程。
  try {
    const warmIndexPath = path.join(memDir, "hot", "warm_monthly_index.json");
    const warmIndex = loadJsonFileIfExists(warmIndexPath, { months: [] });
    let monthEntry = warmIndex.months.find((m) => m.year === parseInt(year) && m.month === parseInt(month));
    if (!monthEntry) {
      monthEntry = { year: parseInt(year), month: parseInt(month), summary: "", days_with_data: [] };
      warmIndex.months.push(monthEntry);
    }
    const dayNum = parseInt(day);
    if (!monthEntry.days_with_data.includes(dayNum)) {
      monthEntry.days_with_data.push(dayNum);
      monthEntry.days_with_data.sort((a, b) => a - b);
      monthEntry.summary = `${year}年${month}月，共${monthEntry.days_with_data.length}天有记忆数据`;
      saveJsonFile(warmIndexPath, warmIndex);
    }
  } catch (e) {
    console.warn(`[beilu-memory] archiveTempMemory 月索引同步失败: ${e.message}`);
  }

  wbT(null, "backgroundTasks", "archiveTempMemory:done", { archived: archivedCount, batchFiles });
  console.log(
    `[beilu-memory] #4 归档了 ${archivedCount} 条临时记忆到 ${batchFiles.length} 个 batch 文件 (${charName})`,
  );

  return { archived: archivedCount, batchFiles };
}

// ============================================================
// 表格归档系统（泛化）：任意 mode 的任意自定义表按「超出行数上限」迁移到归档区
// 20260726 单线收口：原经验表专线 archiveModeTable（硬编码表号 code#4/work#3 + 日期 cutoff 选行 + 落温层）
//   已整函数删除——它与本泛化线并行且互相排斥，造成用户配置永不生效的死配置（详见 autoCheckArchiveTriggers）。
//   本函数=用户自定义任意 tableId + 行数上限/rowIndices 选行 + chat/code/work 全模式，归档目录 hot/archive/tables/<mode>/（tableArchiveDir 单源）。
// ============================================================

/**
 * 归档文件写入原语（同日追加合并 + F2 列值指纹幂等去重）。
 *
 * 唯一使用方=archiveTableRowsGeneric（20260726 单线收口后原第二使用方 archiveModeTable 已删除，决议2
 *   「现有 code/work 一字不动」硬约束，不改其函数体防行为漂移）。
 * F2 幂等：归档文件 saveJsonFile 同步、瘦身落表 saveTablesData 现已 await（T1）但内部写盘仍在微任务链，
 *   进程在 await 前被强杀 / 未 drain 完退出，两者间崩溃仍会重归档同样的行 → 同日文件累积重复。
 *   按列值指纹去重使重复触发为 no-op（archived_at 时间戳不参与指纹）。
 *
 * @param {string} archiveFile 归档文件绝对路径
 * @param {object} meta { date, mode, tableId, tableName, columns }
 * @param {string[][]} oldRows 要归档的行（二维数组）
 * @returns {number} 实际写入（去重后）的条数
 */
function _appendTableArchiveFile(archiveFile, meta, oldRows) {
  const { date, mode, tableId, tableName, columns } = meta;
  const _cols = columns || [];
  const _newEntries = oldRows.map((row) => {
    const _o = { archived_at: new Date().toISOString() };
    for (let i = 0; i < _cols.length; i++) _o[_cols[i]] = row[i] ?? "";
    // 修9（凛倾 20260716「前面是关键词+时间，后面是内容」）：列名键条目对 normalizeEntry 的 content
    //   兜底链必然 miss=P1 召回死条目；补 content=行值拼接后过格式单源（keywords+timestamp 头部排序）。
    //   normalizeEntry 不覆盖已有键 → 列名键值原样保留，恢复链（restoreTableArchiveRows 按列名取值）
    //   与 F2 指纹去重（按列值）零影响。
    if (!_o.content) _o.content = row.filter(Boolean).join(" · ");
    return normalizeEntry(_o, "table_archive");
  });
  let _doc = {
    date, mode, table: `#${tableId} ${tableName || ""}`, tableId,
    columns: _cols, count: 0, entries: [],
  };
  if (fs.existsSync(archiveFile)) {
    const _prev = loadJsonFileIfExists(archiveFile, null);
    if (_prev && Array.isArray(_prev.entries)) _doc = _prev;
  }
  // F2 列值指纹去重（archived_at 时间戳不参与指纹，否则去重失效）
  const _fp = (o) => _cols.length > 0
    ? _cols.map((c) => String(o[c] ?? "")).join("\u0001")
    : Object.values(o).filter((v) => v !== o.archived_at).map(String).join("\u0001");
  const _existingFps = new Set((_doc.entries || []).map(_fp));
  const _dedupNew = _newEntries.filter((e) => {
    const fp = _fp(e);
    if (_existingFps.has(fp)) return false;
    _existingFps.add(fp);
    return true;
  });
  _doc.entries.push(..._dedupNew);
  _doc.count = _doc.entries.length;
  _doc.columns = _cols;
  _doc.table = `#${tableId} ${tableName || ""}`;
  _doc.tableId = tableId;
  _doc.mode = mode;
  saveJsonFile(archiveFile, _doc);
  return _dedupNew.length;
}

/**
 * 表格行归档目录唯一解析器 —— 落点＝凛倾设计的分层目录本身（20260726 归位）。
 *
 * 【为什么从 hot 改回来】0716 曾裁决「归档只可以变成文件储存在热层」，落点被改成
 *   hot/archive/tables/<mode>/（在"活跃层"里再套四层）。那次的真实病因是
 *   「<mode>/archive/ 的**子目录**对温层扫描不可见（aiRunner available_data 只收 isFile）
 *   ＋关键词检索原只扫 .json」＝归档即消失；正确修法是不建子目录 + 检索扩 .md（retrieval 已扩），
 *   而不是换个落点绕过。旧落点让凛倾设计的 code/archive/ 长期空置，且归档产物落进
 *   "会被检索注入"的 hot，与前端层语义（hot=活跃 / warm=近期 / cold=已归档，memoryBrowser.mjs:140-144）冲突。
 * 【现落点】code → code/archive/ ・ work → work/archive/ ・ chat → cold/tables/
 *   一律**直接放文件、不建子目录** → 温层枚举(isFile) 与 searchMemoryFiles(.json/.md) 均可达。
 * 【存量归位】把落错位置的 hot/archive/tables/<mode>/* 及更早的 <mode>/archive/tables/*、archive/tables/*
 *   一次性 rename 回本落点（幂等，每进程每 mode 判一次）；同名冲突插 _migrated<ts> 保后缀契约。
 * 写/列/取/恢复的路径公式全走本解析器（单一权威）。
 * @param {string} memDir
 * @param {string} mode - chat/code/work（非法值回退 chat，同 _resolveTableMode 值域）
 * @returns {{ absDir:string, relPrefix:string }} relPrefix 用于回传 file 相对路径（前端 list/get/restore 用）
 */
const _archiveMigratedMemo = new Set();
export function tableArchiveDir(memDir, mode) {
  const _m = (mode === "code" || mode === "work") ? mode : "chat";
  // 归档＝降温：code/work 落各自模式的 archive 层；chat 落三温层的 cold（前端标签「已归档」）
  const relPrefix = _m === "chat" ? "cold/tables" : _m + "/archive";
  const absDir = path.join(memDir, ...relPrefix.split("/"));
  const _memoKey = memDir + "\u0001tables\u0001" + _m;
  if (!_archiveMigratedMemo.has(_memoKey)) {
    _archiveMigratedMemo.add(_memoKey);
    // 旧落点按时间倒序归位：hot 四层嵌套（0716~0726 错落点）→ 更早的 <mode>/archive/tables/ 与 archive/tables/
    const _legacyDirs = [
      path.join(memDir, "hot", "archive", "tables", _m),
      _m === "chat" ? path.join(memDir, "archive", "tables") : path.join(memDir, _m, "archive", "tables"),
    ];
    for (const _legacyDir of _legacyDirs) {
      try {
        if (!fs.existsSync(_legacyDir) || path.resolve(_legacyDir) === path.resolve(absDir)) continue;
        const _files = fs.readdirSync(_legacyDir).filter((f) => f.endsWith("_archive.json") || f.endsWith("_archive.md"));
        if (_files.length > 0) {
          fs.mkdirSync(absDir, { recursive: true });
          for (const _f of _files) {
            let _dst = path.join(absDir, _f);
            if (fs.existsSync(_dst)) _dst = path.join(absDir, _f.replace(/_archive\.(json|md)$/, "_migrated" + Date.now() + "_archive.$1"));
            fs.renameSync(path.join(_legacyDir, _f), _dst);
          }
          console.log("[beilu-memory] 归档归位: " + _legacyDir + " → " + absDir + " (" + _files.length + " 件)");
        }
        if (fs.readdirSync(_legacyDir).length === 0) fs.rmdirSync(_legacyDir);
      } catch (e) {
        wbD(null, "backgroundTasks", "tableArchiveDir:migrate_fail", false, "归档归位失败(旧位文件保留原地，本轮 list 看不到未迁存量)", { legacyDir: _legacyDir, absDir, err: e.message });
      }
    }
  }
  return { absDir, relPrefix };
}

/**
 * 热层 md 归档目录解析器（修8 20260716，凛倾「归档只可以变成文件储存在热层」裁决同族）。
 * code/work 热层 md 归档统一落 hot/archive/md/<mode>/<YYYY-MM>/。
 * 旧落点 <mode>/archive/<YYYY-MM>/*.md 双重不可达：aiRunner 温层扫描 isFile 跳子目录 +
 * retrieval 关键词检索原只扫 .json → 归档即对 AI 永久消失。首次访问把旧 YYYY-MM 子目录的
 * .md 迁入热层归位；*_archive.json 经验表归档留守温层直下（决议2「一字不动」域不碰）。
 * @returns {{ absDir:string, relPrefix:string }}
 */
const _mdArchiveMigratedMemo = new Set();
export function mdArchiveDir(memDir, mode, ym) {
  const _m = mode === "work" ? "work" : "code";
  const absDir = path.join(memDir, "hot", "archive", "md", _m, ym);
  const _memoKey = `${memDir}\u0001${_m}`;
  const _legacyRoot = path.join(memDir, _m, "archive");
  if (!_mdArchiveMigratedMemo.has(_memoKey)) {
    _mdArchiveMigratedMemo.add(_memoKey);
    try {
      if (fs.existsSync(_legacyRoot)) {
        let _movedN = 0;
        for (const _sub of fs.readdirSync(_legacyRoot)) {
          if (!/^\d{4}-\d{2}$/.test(_sub)) continue;
          const _subDir = path.join(_legacyRoot, _sub);
          if (!fs.statSync(_subDir).isDirectory()) continue;
          const _dstDir = path.join(memDir, "hot", "archive", "md", _m, _sub);
          for (const _f of fs.readdirSync(_subDir)) {
            if (!_f.endsWith(".md")) continue;
            fs.mkdirSync(_dstDir, { recursive: true });
            let _dst = path.join(_dstDir, _f);
            if (fs.existsSync(_dst)) _dst = path.join(_dstDir, _f.replace(/\.md$/, `.migrated${Date.now()}.md`));
            fs.renameSync(path.join(_subDir, _f), _dst);
            _movedN++;
          }
          if (fs.readdirSync(_subDir).length === 0) fs.rmdirSync(_subDir);
        }
        if (_movedN > 0) console.log(`[beilu-memory] md 归档存量归位热层: ${_legacyRoot}/<YYYY-MM> → hot/archive/md/${_m}/ (${_movedN} 件)`);
      }
    } catch (e) {
      wbD(null, "backgroundTasks", "mdArchiveDir:migrate_fail", false, "md 归档存量归位热层失败(旧位文件保留原地)", { legacyRoot: _legacyRoot, err: e.message });
    }
  }
  return { absDir, relPrefix: `hot/archive/md/${_m}/${ym}` };
}

// 表格归档参数默认值单一权威源（20260712 凛倾「超出多少进行归档/每次归档多少条/文件命名」设置面）。
//   引擎缺省、verb 层回读缺省、前端 placeholder 三处全从这里取，禁各层各写一份 80/20 硬数字。
//   archive_batch=0 表示不限（一次迁走全部超出行）；file_name_template 支持
//   {date}/{time}/{tableId}/{tableName}/{count}（凛倾 2026-07-16「按照日期+时间+列表名字+条目数量，
//   归档到热层」——默认模板即此形状，每次归档独立成文件）；
//   最终文件名固定拼 `_archive.json` 后缀（listTableArchives 扫描与 getTableArchive 越界校验都锚定该后缀，模板不许改后缀）。
export const TABLE_ARCHIVE_DEFAULTS = {
  enabled: false, // 「chat 现状无表格归档默认关」决议（setDataActions _ARCHIVE_SPEC 注释）
  max_rows: 80,
  keep_recent: 20,
  archive_batch: 0,
  // min_archive_rows（20260726 加）：单次归档不足此行数则整轮跳过，攒够再一次性搬。
  //   【为什么必须有】选行量 = 行数 - keep_recent。当用户把 max_rows 配得接近或等于 keep_recent
  //   （实测：用户配 max_rows=20，keep_recent 留空走默认 20）→ 滞后区归零 →
  //   21 行搬 1 行、22 行搬 2 行……每超一行就归档一次，且默认文件名含 {time}/{count}=每次独立成文件
  //   → 归档目录里堆满"1 条"的碎片档。本下限是滞后区的机制保证，与 max_rows/keep_recent 的取值无关。
  //   0 = 关闭该保护（每次超限即搬，恢复旧行为）。
  min_archive_rows: 10,
  file_name_template: "{date}_{time}_{tableName}_{count}条",
};

// 归档文件名构建：模板代入 → 去路径危险字符（斜杠/点等全落 _，防目录穿越）→ 空回退默认模板形状。
//   合并语义随文件名走：模板含 {time}/{count}（默认）=每次归档独立文件；只含 {date} 则「同日一文件」
//   合并+去重；都不含则长期合并进同一文件。
function _buildArchiveFileName(template, { date, tableId, tableName, count }) {
  const _tpl = (typeof template === "string" && template.trim()) ? template.trim() : TABLE_ARCHIVE_DEFAULTS.file_name_template;
  const _now = new Date();
  const _time = `${String(_now.getHours()).padStart(2, "0")}${String(_now.getMinutes()).padStart(2, "0")}${String(_now.getSeconds()).padStart(2, "0")}`;
  let _base = _tpl
    .replaceAll("{date}", date)
    .replaceAll("{time}", _time)
    .replaceAll("{tableId}", String(tableId))
    .replaceAll("{tableName}", String(tableName || ""))
    .replaceAll("{count}", String(count ?? ""));
  _base = _base.replace(/[^\p{L}\p{N}_-]/gu, "_").slice(0, 60);
  if (!_base) _base = `${date}_t${tableId}`;
  return `${_base}_archive.json`;
}

/**
 * 泛化表格行归档：把指定 mode 的指定表（任意 tableId）的「超出行数上限」旧行迁移到归档区（纯 JSON 不压缩）。
 *
 * 链路：verb archiveTableRows / autoCheckArchiveTriggers(chat 表超限) → archiveTableRowsGeneric
 *        → _appendTableArchiveFile(归档文件) + saveTablesData(瘦身后表)
 * 影响：写 <archiveDir>/<YYYY-MM-DD>_t<tableId>_archive.json（同日合并 + F2 去重）；
 *        修改内存表 rows（迁走旧行），saveTablesData 落盘
 * 选行策略（设计 §2.2 + 决议2）：
 *   - rowIndices 传了（非空数组）→ 按索引归档（降序 splice 防漂移，复用 archiveCompletedTasks :299/:312 范式）
 *   - 否则按行数上限：rows 超过 maxRows 时，迁走最旧的 (len - keepRecent) 行。
 *     「最旧=数组前部」（rows.push 尾插 tableEngine.mjs:89，index 0 最旧）→ slice(0, N) 迁走、slice(N) 保留。
 * 约束：必须用 mode 作 forceMode（下方 saveTablesData 也按 mode 写回，防 active_mode 分叉读写错位）。
 *
 * @param {string} username
 * @param {string} charName
 * @param {"chat"|"code"|"work"} mode
 * @param {number} tableId 要归档的表 id
 * @param {string} [chatId] per-chatId 模式解析 + 写回
 * @param {object} [opts] { rowIndices?:number[], keepRecent?:number, maxRows?:number,
 *                          archiveBatch?:number（每次归档条数上限，0/缺省=不限，超出行一次全迁）,
 *                          fileNameTemplate?:string（{date}/{tableId}/{tableName}，缺省 TABLE_ARCHIVE_DEFAULTS）,
 *                          discard?:boolean（修4' 20260716 移出域单引擎：true=移出但不写归档文件（=删除语义），
 *                            选行/瘦身/落盘全同归档——「删除」只是「不保留档案」的参数，不再是前端第二套 splice 实现；
 *                            快照保护由 verb 层统一建） }
 * @returns {{ archived:number, file:string, remaining:number, rev?:number }}
 */
export async function archiveTableRowsGeneric(username, charName, mode, tableId, chatId, opts = {}) {
  wbT(chatId || null, "backgroundTasks", "archiveTableRowsGeneric:enter", { username, charName, mode, tableId, chatId });
  const _mode = (mode === "code" || mode === "work") ? mode : "chat";
  const data = loadMemoryData(username, charName, _mode, chatId);
  const _tbl = data.tables.find((t) => t.id === tableId);
  if (!_tbl || !Array.isArray(_tbl.rows) || _tbl.rows.length === 0) {
    return { archived: 0, file: "", remaining: _tbl?.rows?.length || 0 };
  }
  const _cols = _tbl.columns || [];

  // ── 选行 ──
  let _oldRows;
  let _keepMask; // true=保留
  const _hasIndices = Array.isArray(opts.rowIndices) && opts.rowIndices.length > 0;
  if (_hasIndices) {
    const _idxSet = new Set(opts.rowIndices.filter((i) => Number.isInteger(i) && i >= 0 && i < _tbl.rows.length));
    _oldRows = _tbl.rows.filter((_r, i) => _idxSet.has(i));
    _keepMask = _tbl.rows.map((_r, i) => !_idxSet.has(i));
  } else {
    // 行数上限策略：缺省全走 TABLE_ARCHIVE_DEFAULTS 单源（原 80/20 硬数字收口，决议1 数值不变）
    const _keepRecent = Number.isFinite(opts.keepRecent) ? Math.max(0, opts.keepRecent) : TABLE_ARCHIVE_DEFAULTS.keep_recent;
    const _maxRows = Number.isFinite(opts.maxRows) ? Math.max(1, opts.maxRows) : TABLE_ARCHIVE_DEFAULTS.max_rows;
    if (_tbl.rows.length <= _maxRows) {
      return { archived: 0, file: "", remaining: _tbl.rows.length }; // 未超限，no-op
    }
    let _cut = _tbl.rows.length - _keepRecent; // 迁走最旧的 _cut 行
    // 每次归档条数上限（凛倾 20260712「每次归档多少条」）：>0 时单次触发最多迁这么多行；
    //   自动触发链每轮回复都会再判超限，剩余超出行由后续轮次分批消化（渐进瘦身，防一次大搬移）。
    const _batch = Number.isFinite(opts.archiveBatch) ? Math.floor(opts.archiveBatch) : TABLE_ARCHIVE_DEFAULTS.archive_batch;
    if (_batch > 0) _cut = Math.min(_cut, _batch);
    if (_cut <= 0) return { archived: 0, file: "", remaining: _tbl.rows.length };
    // 单次归档行数下限（20260726 防碎片化）：不足则整轮跳过，攒够再一次性搬。
    //   病：keep_recent ≥ max_rows 时滞后区归零（用户配 max_rows=20 + keep_recent 默认 20 实测），
    //   变成「每超一行归档一行」，且默认文件名含 {time}/{count} → 每行一个碎片档。
    //   手动归档（用户显式点「立即归档」）不受此限——用户主动要求就照做，不替他判断值不值得。
    const _minRows = Number.isFinite(opts.minArchiveRows) ? Math.max(0, opts.minArchiveRows) : TABLE_ARCHIVE_DEFAULTS.min_archive_rows;
    if (!opts.manual && _minRows > 0 && _cut < _minRows) {
      return { archived: 0, file: "", remaining: _tbl.rows.length, skipped: `不足单次归档下限 ${_minRows} 行（当前可归档 ${_cut} 行），攒够再搬` };
    }
    _oldRows = _tbl.rows.slice(0, _cut);
    _keepMask = _tbl.rows.map((_r, i) => i >= _cut);
  }
  if (_oldRows.length === 0) return { archived: 0, file: "", remaining: _tbl.rows.length };

  // ── 写归档文件（discard=删除语义时跳过：移出但不留档，其余步骤与归档全同） ──
  let _relFile = "";
  let _written = 0;
  let _absFile = "";
  let _fileWasNew = false; // 落表失败补偿判据：本次新建的档才可回滚删除（合并进既有档不可删=会误删旧条目）
  if (!opts.discard) {
    const _memDir = getMemoryDir(username, charName);
    const { absDir, relPrefix } = tableArchiveDir(_memDir, _mode);
    if (!fs.existsSync(absDir)) fs.mkdirSync(absDir, { recursive: true });
    const _today = getTodayStr();
    // 文件命名走用户模板（凛倾 20260716：默认=日期+时间+表名+条目数，每次归档独立文件）
    _absFile = path.join(absDir, _buildArchiveFileName(opts.fileNameTemplate, { date: _today, tableId, tableName: _tbl.name, count: _oldRows.length }));
    _fileWasNew = !fs.existsSync(_absFile);
    _written = _appendTableArchiveFile(_absFile, { date: _today, mode: _mode, tableId, tableName: _tbl.name, columns: _cols }, _oldRows);
    _relFile = `${relPrefix}/${path.basename(_absFile)}`;
  }

  // ── 瘦身 live 表 + 落盘（rev 递增，与 updateTable 乐观并发一致）──
  _tbl.rows = _tbl.rows.filter((_r, i) => _keepMask[i]);
  _tbl.rev = Number(_tbl.rev || 0) + 1;
  // T1：归档链 await 化——瘦身后落表从 fire-and-forget 改 await，写盘失败向上抛（不静默丢盘）。
  const _wg = await saveTablesData(username, charName, _mode, chatId);
  if (_wg && _wg.ok === false) {
    // 补偿回滚：表未瘦身而档已写=孤儿档（数据双份，恢复=重复行）。本次新建的档删除回滚；
    // 合并进既有档的（用户自定义无 {time}/{count} 模板）不可删——留痕提示可能重复恢复。
    if (_fileWasNew && _absFile) {
      try { fs.unlinkSync(_absFile); }
      catch (_ue) { wbD(chatId || null, "backgroundTasks", "archiveTableRowsGeneric:orphan_rollback_fail", false, "落表失败且孤儿档删除失败(该档与表数据重复,恢复会出重复行)", { file: _absFile, err: _ue.message }); }
    } else if (_relFile) {
      wbD(chatId || null, "backgroundTasks", "archiveTableRowsGeneric:orphan_merged", false, "落表失败但条目已合并进既有归档文件(F2指纹可挡同内容重归档,恢复该档会含未瘦身条目)", { file: _relFile });
    }
    throw new Error(`archiveTableRowsGeneric saveTablesData 失败: ${_wg.error}`);
  }

  wbT(chatId || null, "backgroundTasks", "archiveTableRowsGeneric:done", { archived: _oldRows.length, written: _written, discard: !!opts.discard, remaining: _tbl.rows.length });
  console.log(
    `[beilu-memory] 表格${opts.discard ? "移出(不留档)" : "归档"} ${_oldRows.length} 行 #${tableId}(${_tbl.name || ""})${_relFile ? ` → ${_relFile}` : ""} (${_mode}/${charName})`,
  );
  return { archived: _oldRows.length, file: _relFile, remaining: _tbl.rows.length, rev: _tbl.rev };
}

// ============================================================
// #9 时空记忆维护：只保留后两天的内容
// ============================================================

/**
 * #9 时空记忆维护：删除超过 2 天的旧条目（硬编码 2 天，不可配）。
 *
 * 链路：autoCheckArchiveTriggers(仅 chat 模式) / endDay 尾步 → maintainTimeSpaceTable → saveTablesData
 * 影响：修改 table9.rows（过滤旧行）、落盘 saveTablesData
 *
 * @param {string} username
 * @param {string} charName
 * @returns {{ removed: number }}
 */
export async function maintainTimeSpaceTable(username, charName) {
  const data = loadMemoryData(username, charName, "chat"); // 修6：#9=chat 域固定表（判据同 archiveRememberAboutUser 注释）
  const table9 = data.tables.find((t) => t.id === 9);
  if (!table9 || table9.rows.length === 0) return { removed: 0 };

  const twoDaysAgo = getDaysAgoStr(2);
  const before = table9.rows.length;
  table9.rows = table9.rows.filter((row) => {
    const date = row[0] || "";
    return date >= twoDaysAgo;
  });
  const removed = before - table9.rows.length;

  if (removed > 0) {
    // T1：归档链 await 化——瘦身后落表从 fire-and-forget 改 await，写盘失败向上抛（不静默丢盘）。
    const _w9 = await saveTablesData(username, charName, data.activeMode);
    if (_w9 && _w9.ok === false) throw new Error(`maintainTimeSpaceTable saveTablesData 失败: ${_w9.error}`);
    console.log(
      `[beilu-memory] #9 清理了 ${removed} 条超过2天的时空记忆 (${charName})`,
    );
  }
  return { removed };
}

// ============================================================
// 日终归档流程（"结束今天"按钮触发）
// ============================================================

/**
 * 日终归档流程（"结束今天"按钮触发），9 步顺序执行 + 尾步维护。
 *
 * 步骤：
 *   1. 合并 #6(大总结) + #4(临时记忆) → summaryLines/keyEvents
 *   2. 写 warm/{y}/{m}/{d}_summary.json → 为什么先写摘要：摘要是 warm 层索引键
 *   3. keyEvents 前 10 条写入 #9(时空记忆)
 *   4. 清空 #6
 *   5. archiveRememberAboutUser(#7)
 *   6. [跳过] archiveCompletedTasks（需手动标记）
 *   7. archiveTempMemory(#4) → 为什么在 Step1 用完 #4 后才归档：先读再清
 *   8. 更新 hot/warm_monthly_index.json
 *   9. 清空 #0
 *   尾步: maintainTimeSpaceTable + archiveForeverEntries + saveTablesData
 * 不变量：无论哪步失败，最终 saveTablesData 都会执行（内存表变更必须落盘）
 *
 * 链路：setDataActions("endDay") → endDay → 各 archive* + saveTablesData
 * 影响：写 warm/ 摘要、修改多张内存表、落盘 saveTablesData
 *
 * @param {string} username
 * @param {string} charName
 * @returns {{ steps: object[], date: string }}
 */
export async function endDay(username, charName) {
  wbT(null, "backgroundTasks", "endDay:enter", { username, charName });
  // 日终九步含多处破坏性清空（#6 清空/#4 归档清行）→ 执行前全量快照（force：每次 endDay 必拍），
  // 失败不阻断（保险层语义，createArchiveSnapshot 内部吞错可见）
  createArchiveSnapshot(username, charName, "endDay 日终归档前自动快照", { force: true });
  const steps = [];
  const today = getTodayStr();
  const [year, month, day] = today.split("-");
  const memDir = getMemoryDir(username, charName);
  // 修6：endDay 九步全锚 chat 域固定表（#0/#4/#6/#9），mode 锚 "chat"——原按 active_mode 加载，
  //   code/work 会话点「结束今天」会对 code/work 表集做清空/归档（id 撞车跨域破坏）。
  const data = loadMemoryData(username, charName, "chat");

  // Step 1: 合并 #6(大总结) + #4(临时记忆) 生成完整日总结
  const table6 = data.tables.find((t) => t.id === 6);
  const table4_for_summary = data.tables.find((t) => t.id === 4);
  const activeMode = getActiveMode(username, charName) || "chat";

  const summaryLines = [];
  const keyEvents = [];

  // #6 当天事件大总结: ["时间", "地点", "事件概述"]
  if (table6 && table6.rows.length > 0) {
    for (const row of table6.rows) {
      const line = `${row[0] || ""} ${row[1] || ""}: ${row[2] || ""}`.trim();
      if (line && line !== ":") summaryLines.push(line);
      if (row[2]) keyEvents.push(row[2]);
    }
  }

  // #4 临时记忆补充（chat模式: ["角色","事件简述","日期","地点","情绪"]）
  if (table4_for_summary && table4_for_summary.rows.length > 0) {
    const existingEvents = new Set(keyEvents.map((e) => e.toLowerCase().trim()));
    for (const row of table4_for_summary.rows) {
      const eventText = (activeMode === "chat" || activeMode === "smart") // smart 升独立模式值后与 chat 同表结构（表暂落 chat 桶），同走简式
        ? `${row[0] || ""}: ${row[1] || ""}`.trim()
        : table4_for_summary.columns
          ? table4_for_summary.columns.map((col, i) => `${col}: ${row[i] || ""}`).join(" / ")
          : row.join(" / ");
      const checkKey = (row[1] || eventText).toLowerCase().trim();
      if (checkKey && !existingEvents.has(checkKey)) {
        summaryLines.push(eventText);
        existingEvents.add(checkKey);
        if (row[1]) keyEvents.push(row[1]);
      }
    }
  }

  const mergedSources = [];
  if (table6 && table6.rows.length > 0) mergedSources.push(`#6(${table6.rows.length}条)`);
  if (table4_for_summary && table4_for_summary.rows.length > 0)
    mergedSources.push(`#4(${table4_for_summary.rows.length}条)`);

  steps.push({
    step: 1,
    action: "generate_day_summary",
    status: "done",
    sources: mergedSources,
    events_count: summaryLines.length,
  });

  // Step 2: 生成日总结文件
  try {
    const warmDir = path.join(memDir, "warm", year, month);
    if (!fs.existsSync(warmDir)) fs.mkdirSync(warmDir, { recursive: true });
    const summaryPath = path.join(warmDir, `${day}_summary.json`);
    const summaryData = {
      date: today,
      title: `${today} 日总结`,
      summary: summaryLines.join("\n") || "(当日无记录)",
      key_events: keyEvents.filter(Boolean),
      tags: [],
      _mode: activeMode,
      _sources: mergedSources,
      created_at: new Date().toISOString(),
    };
    saveJsonFile(summaryPath, summaryData);
    steps.push({ step: 2, action: "save_day_summary", status: "done", file: summaryPath });
  } catch (e) {
    console.error(`[beilu-memory] endDay Step2 写日总结失败:`, e.message);
    steps.push({ step: 2, action: "save_day_summary", status: "error", error: e.message });
  }

  // Step 3: #9 时空记忆表格 <- 合并后的摘要写入
  try {
    const table9 = data.tables.find((t) => t.id === 9);
    if (table9) {
      const condensed = keyEvents.length > 0
        ? keyEvents.slice(0, 10).join("; ")
        : summaryLines.slice(0, 5).join("; ");
      table9.rows.push([today, condensed || "(无记录)"]);
    }
    steps.push({ step: 3, action: "transfer_to_table9", status: "done" });
  } catch (e) {
    console.error(`[beilu-memory] endDay Step3 写#9失败:`, e.message);
    steps.push({ step: 3, action: "transfer_to_table9", status: "error", error: e.message });
  }

  // Step 4: #6 清空
  if (table6) table6.rows = [];
  steps.push({ step: 4, action: "clear_table6", status: "done" });

  // Step 5: #7 超过3天的条目归档
  try {
    const step5 = await archiveRememberAboutUser(username, charName); // T1：await 归档落盘（失败落 Step5 catch）
    steps.push({ step: 5, action: "archive_remember_about_user", status: "done", archived: step5.archived });
  } catch (e) {
    console.error(`[beilu-memory] endDay Step5 归档#7失败:`, e.message);
    steps.push({ step: 5, action: "archive_remember_about_user", status: "error", error: e.message });
  }

  // Step 6: #3 已完成任务归档（需手动标记，暂跳过）
  steps.push({ step: 6, action: "archive_completed_tasks", status: "skipped", note: "需要手动标记已完成的任务" });

  // Step 7: #4 剩余未归档的临时记忆归档
  try {
    const step7 = await archiveTempMemory(username, charName); // T1：await 归档落盘（失败落 Step7 catch）
    steps.push({ step: 7, action: "archive_temp_memory", status: "done", archived: step7.archived, batchFiles: step7.batchFiles });
  } catch (e) {
    console.error(`[beilu-memory] endDay Step7 归档#4失败:`, e.message);
    steps.push({ step: 7, action: "archive_temp_memory", status: "error", error: e.message });
  }

  // Step 8: 更新 hot/warm_monthly_index.json
  try {
    const warmIndexPath = path.join(memDir, "hot", "warm_monthly_index.json");
    const warmIndex = loadJsonFileIfExists(warmIndexPath, { months: [] });
    let monthEntry = warmIndex.months.find(
      (m) => m.year === parseInt(year) && m.month === parseInt(month),
    );
    if (!monthEntry) {
      monthEntry = { year: parseInt(year), month: parseInt(month), summary: "", days_with_data: [] };
      warmIndex.months.push(monthEntry);
    }
    const dayNum = parseInt(day);
    if (!monthEntry.days_with_data.includes(dayNum)) {
      monthEntry.days_with_data.push(dayNum);
      monthEntry.days_with_data.sort((a, b) => a - b);
    }
    monthEntry.summary = `${year}年${month}月，共${monthEntry.days_with_data.length}天有记忆数据`;
    saveJsonFile(warmIndexPath, warmIndex);
    steps.push({ step: 8, action: "update_warm_monthly_index", status: "done" });
  } catch (e) {
    console.error(`[beilu-memory] endDay Step8 更新月索引失败:`, e.message);
    steps.push({ step: 8, action: "update_warm_monthly_index", status: "error", error: e.message });
  }

  // Step 9: #0 时空表格清空（新的一天）
  const table0 = data.tables.find((t) => t.id === 0);
  if (table0) table0.rows = [];
  steps.push({ step: 9, action: "clear_table0", status: "done" });

  // 维护任务（独立 catch 防止影响 saveTablesData）——T1：await 归档落盘（失败落各自 catch，不阻断收尾 save）
  try { await maintainTimeSpaceTable(username, charName); } catch (e) { console.error(`[beilu-memory] endDay maintainTimeSpaceTable 失败:`, e.message); }
  try { await archiveForeverEntries(username, charName); } catch (e) { console.error(`[beilu-memory] endDay archiveForeverEntries 失败:`, e.message); }

  // 保存所有表格变更（无论上面哪步失败，内存表的变更都必须落盘）
  // T1：收尾落表从 fire-and-forget 改 await，写盘失败向上抛（endDay 头注释"最终 saveTablesData 都会执行"要求落盘可靠）。
  const _wEnd = await saveTablesData(username, charName, data.activeMode);
  if (_wEnd && _wEnd.ok === false) throw new Error(`endDay saveTablesData 失败: ${_wEnd.error}`);

  wbT(null, "backgroundTasks", "endDay:done", { date: today, stepCount: steps.length });
  const _failedSteps = steps.filter((s) => s.status === "error");
  if (_failedSteps.length > 0) console.warn(`[beilu-memory] endDay 部分步骤失败:`, _failedSteps.map((s) => `Step${s.step}:${s.error}`).join(", "));
  console.log(
    `[beilu-memory] 日终归档完成 (${charName}):`,
    steps.map((s) => `Step${s.step}:${s.status}`).join(", "),
  );
  return { steps, date: today };
}

// ============================================================
// 冷归档：将超过30天的温记忆移入冷层
// ============================================================

/**
 * 冷归档：将超过 cold_archive_after_days 天的 warm 月目录整体搬入 cold 层，更新双向索引。
 *
 * 链路：autoCheckArchiveTriggers(每天最多 1 次，_last_warm_cold_archive 日戳闸) → archiveWarmToCold
 * 影响：文件搬移 warm/{year}/{month}/ → cold/{year}/{month}/（copy+unlink，非原子 rename —— 跨卷可能）
 *        写 warm/cold_yearly_index.json（冷层年索引）
 *        写 hot/warm_monthly_index.json（过滤已搬走的月）
 *
 * @param {string} username
 * @param {string} charName
 * @returns {{ moved: number }}
 */
export function archiveWarmToCold(username, charName) {
  const data = loadMemoryData(username, charName);
  const config = data.config;
  const coldAfterDays = config?.archive?.cold_archive_after_days || 30;
  const cutoffDate = getDaysAgoStr(coldAfterDays);
  const [cutYear, cutMonth] = cutoffDate.split("-").map(Number);

  const memDir = getMemoryDir(username, charName);
  const warmBaseDir = path.join(memDir, "warm");
  let moved = 0;

  if (!fs.existsSync(warmBaseDir)) return { moved: 0 };

  const years = fs.readdirSync(warmBaseDir).filter((f) => /^\d{4}$/.test(f));
  for (const yearStr of years) {
    const yearDir = path.join(warmBaseDir, yearStr);
    if (!fs.statSync(yearDir).isDirectory()) continue;

    const months = fs.readdirSync(yearDir).filter((f) => /^\d{2}$/.test(f));
    for (const monthStr of months) {
      const y = parseInt(yearStr),
        m = parseInt(monthStr);
      if (y > cutYear || (y === cutYear && m >= cutMonth)) continue;

      const monthDir = path.join(yearDir, monthStr);
      if (!fs.statSync(monthDir).isDirectory()) continue;

      const coldMonthDir = path.join(memDir, "cold", yearStr, monthStr);
      if (!fs.existsSync(coldMonthDir))
        fs.mkdirSync(coldMonthDir, { recursive: true });

      const files = fs.readdirSync(monthDir);
      for (const file of files) {
        const srcPath = path.join(monthDir, file);
        const destPath = path.join(coldMonthDir, file);
        if (fs.statSync(srcPath).isDirectory()) {
          if (!fs.existsSync(destPath))
            fs.mkdirSync(destPath, { recursive: true });
          const subFiles = fs.readdirSync(srcPath);
          for (const sf of subFiles) {
            fs.copyFileSync(path.join(srcPath, sf), path.join(destPath, sf));
          }
          fs.rmSync(srcPath, { recursive: true });
        } else {
          fs.copyFileSync(srcPath, destPath);
          fs.unlinkSync(srcPath);
        }
        moved++;
      }

      try {
        fs.rmdirSync(monthDir);
      } catch (e) {
        /* not empty */
      }
    }
    try {
      fs.rmdirSync(yearDir);
    } catch (e) {
      /* not empty */
    }
  }

  if (moved > 0) {
    // 更新冷层年索引
    const coldIndexPath = path.join(warmBaseDir, "cold_yearly_index.json");
    const coldIndex = loadJsonFileIfExists(coldIndexPath, { years: [] });
    const coldBaseDir = path.join(memDir, "cold");
    if (fs.existsSync(coldBaseDir)) {
      const coldYears = fs
        .readdirSync(coldBaseDir)
        .filter((f) => /^\d{4}$/.test(f));
      coldIndex.years = coldYears.map((y) => {
        const yearPath = path.join(coldBaseDir, y);
        const coldMonths = fs
          .readdirSync(yearPath)
          .filter((f) => /^\d{2}$/.test(f));
        return {
          year: parseInt(y),
          months: coldMonths.map((m) => {
            const summaryPath = path.join(yearPath, m, "monthly_summary.json");
            const summary = loadJsonFileIfExists(summaryPath, { summary: "" });
            return {
              month: parseInt(m),
              summary: summary.summary || "",
              file: `cold/${y}/${m}/monthly_summary.json`,
            };
          }),
        };
      });
    }
    saveJsonFile(coldIndexPath, coldIndex);

    // 更新温层月索引
    const warmIndexPath = path.join(memDir, "hot", "warm_monthly_index.json");
    const warmIndex = loadJsonFileIfExists(warmIndexPath, { months: [] });
    warmIndex.months = warmIndex.months.filter((m) => {
      return m.year > cutYear || (m.year === cutYear && m.month >= cutMonth);
    });
    saveJsonFile(warmIndexPath, warmIndex);

    console.log(
      `[beilu-memory] 冷归档：移动了 ${moved} 个文件到冷层 (${charName})`,
    );
  }

  return { moved };
}

// ============================================================
// 每轮回复后自动检查是否需要触发归档
// ============================================================

/**
 * 每轮回复后的统一归档触发器：检查各表是否达到归档阈值，达到则执行对应归档。
 *
 * 链路：replyHandler(:3374) 每轮回复后 → autoCheckArchiveTriggers → 各 archive* 函数
 * 影响：按条件触发 archiveTempMemory / archiveRememberAboutUser / archiveForeverEntries /
 *        maintainTimeSpaceTable / archiveTableRowsGeneric / archiveWarmToCold / normalizeForeverEntries
 *        通过 callbacks.onTriggerP2 异步触发 P2 总结 AI（不直接 import aiRunner，防循环依赖）
 * 约束：per-chatId 模式解析——多窗口下 active_mode 恒停 "chat"，必须按 active_modes_map[chatId] 解析，
 *        否则 code/work 窗口永远走 chat 分支（旧 vapor 病根）
 *
 * @param {string} username
 * @param {string} charName
 * @param {object} [callbacks] - 可选回调 { onTriggerP2: async (username, charName, chatId) => void, onTriggerP2Code }
 * @param {object} [opts] - { chatId } 当前对话 ID，用于 per-chatId 模式解析
 */
export async function autoCheckArchiveTriggers(username, charName, callbacks, opts) {
  wbT(opts?.chatId ?? null, "backgroundTasks", "autoCheckArchiveTriggers:enter", { username, charName, chatId: opts?.chatId });
  // per-chatId：按触发窗口的模式归档。多窗口下全局 active_mode 恒停 "chat"
  // （setActiveMode 带 chatId 只写 active_modes_map），必须按 active_modes_map[chatId] 解析，
  // 否则 code/work 窗口永远走 chat 分支 → code/work 经验表永不归档（旧 vapor 病根）。
  const _archChatId = opts?.chatId;
  const _archMode = getActiveMode(username, charName, _archChatId);
  const data = loadMemoryData(username, charName, undefined, _archChatId);

  // ── code/work 表格行归档（唯一线，20260726 单线收口）──
  //   config.<mode>_archive.table_archive = { [tableId]: {enabled, max_rows, keep_recent, ...} }。★默认关。
  //   【为什么只剩一条线】原为双线并行：经验表走 archiveModeTable 专线（硬编码表号 code#4/work#3 +
  //     只归档 archive_age_days 天前旧行 + 落温层），本泛化线则用 `_tid === _expTid` 无条件跳过经验表。
  //     后果实证：用户在设置弹窗给经验表配的 max_rows 保存成功却永不生效（死配置），
  //     而专线因「有日期且早于 cutoff 才选行」在新数据上每轮选中 0 行 —— 两条线都不干活，
  //     凛倾 07-24 配置后 200+ 轮零归档。现全部表（含经验表）统一走用户配置 + archiveTableRowsGeneric。
  //   【零硬编码】哪张表参与、阈值多少，全由用户配置决定；默认值单源 TABLE_ARCHIVE_DEFAULTS。
  //   P2 AI 总结钩子（auto_summary，用户配置默认关）：本轮任一表实际归档≥1 行后异步触发。
  if (_archMode === "code" || _archMode === "work") {
    try {
      const _aKey = _archMode === "code" ? "code_archive" : "work_archive";
      const _aCfg = data.config?.[_aKey] || {};
      if (_aCfg.enabled !== false) {
        const _taCfg = _aCfg.table_archive;
        let _archivedAny = false;
        if (_taCfg && typeof _taCfg === "object") {
          for (const [_tidStr, _entry] of Object.entries(_taCfg)) {
            if (!_entry || _entry.enabled === false) continue;
            const _tid = Number(_tidStr);
            if (!Number.isInteger(_tid)) continue;
            const _t = data.tables.find((t) => t.id === _tid);
            const _max = Number(_entry.max_rows) || TABLE_ARCHIVE_DEFAULTS.max_rows;
            if (_t && Array.isArray(_t.rows) && _t.rows.length > _max) {
              const _r = await archiveTableRowsGeneric(username, charName, _archMode, _tid, _archChatId, {
                maxRows: _max,
                keepRecent: Number.isFinite(_entry.keep_recent) ? _entry.keep_recent : undefined,
                archiveBatch: Number.isFinite(_entry.archive_batch) ? _entry.archive_batch : undefined,
                minArchiveRows: Number.isFinite(_entry.min_archive_rows) ? _entry.min_archive_rows : undefined,
                fileNameTemplate: _entry.file_name_template,
              });
              if (_r.archived > 0) _archivedAny = true;
            }
          }
        }
        if (_archivedAny && _aCfg.auto_summary && callbacks?.onTriggerP2Code) {
          callbacks
            .onTriggerP2Code(username, charName, _archChatId)
            .catch((e) => console.error("[beilu-memory] P2-code 自动总结失败:", e.message));
        }
      }
    } catch (e) {
      wbD(opts?.chatId ?? null, "backgroundTasks", "autoCheckArchiveTriggers:codeWorkTableArchive", false, e.message, { mode: _archMode });
      console.warn(`[beilu-memory] ${_archMode} 表格归档检查失败: ${e.message}`);
    }
    // 注意：不 return —— warm→cold + normalizeForeverEntries 是角色级 housekeeping（模式无关），
    // 本块后无条件跑。仅 chat 表专属归档(#4/#7/#8/#9)用下方 guard 跳过。
  }

  // ── chat 表归档（#4/#7/#8/#9 仅 chat 模式）。guard `_archMode==="chat"` 防把
  //    code#4(错误经验)/work#4(画像) 误当 chat 临时记忆处理。
  const _chatArchEnabled = data.config?.archive?.enabled !== false;
  // 检查 #4 是否超过阈值
  const table4 = data.tables.find((t) => t.id === 4);
  const threshold = data.config?.archive?.temp_memory_threshold || 50;
  if (_chatArchEnabled && _archMode === "chat" && table4 && table4.rows.length > threshold) {
    console.log(
      `[beilu-memory] #4 临时记忆 ${table4.rows.length} 条，超过阈值 ${threshold}，触发归档`,
    );
    // T1：await 归档落盘（失败上抛）。各 chat 归档步各自 try/catch 隔离——归档链已 await 化后，
    //   某步落盘失败不再静默丢盘（wbD 进报错系统），且不阻断后续 #7/#8/#9（保持各步独立既有语义）。
    try {
      await archiveTempMemory(username, charName);
    } catch (e) {
      wbD(_archChatId ?? null, "backgroundTasks", "autoCheckArchiveTriggers:archiveTempMemory", false, e.message, {});
      console.warn(`[beilu-memory] #4 临时记忆归档失败: ${e.message}`);
    }
    // 异步触发 P2 总结AI（通过回调，避免直接依赖 aiRunner）
    if (callbacks?.onTriggerP2) {
      callbacks
        .onTriggerP2(username, charName, _archChatId)
        .catch((e) =>
          console.error("[beilu-memory] P2 自动触发失败:", e.message),
        );
    }
  }

  // 检查 #7 是否有超过3天的条目
  const table7 = data.tables.find((t) => t.id === 7);
  if (_chatArchEnabled && _archMode === "chat" && table7 && table7.rows.length > 0) {
    // 触发器层读同一 config 键，与 archiveRememberAboutUser 执行层一致（避免触发/执行阈值分叉）
    const remDays = data.config?.archive?.remember_archive_days || 3;
    const cutoffStr = getDaysAgoStr(remDays);
    const hasOld = table7.rows.some((row) => (row[0] || "") < cutoffStr);
    if (hasOld) {
      try {
        await archiveRememberAboutUser(username, charName); // T1：await 归档落盘（失败上抛，本步隔离）
      } catch (e) {
        wbD(_archChatId ?? null, "backgroundTasks", "autoCheckArchiveTriggers:archiveRememberAboutUser", false, e.message, {});
        console.warn(`[beilu-memory] #7 关于用户归档失败: ${e.message}`);
      }
    }
  }

  // 检查 #8 是否超过上限（config.archive.forever_max 可配，未配回退 200，与执行层一致）
  const table8 = data.tables.find((t) => t.id === 8);
  if (_chatArchEnabled && _archMode === "chat" && table8 && table8.rows.length > (data.config?.archive?.forever_max || 200)) {
    try {
      await archiveForeverEntries(username, charName); // T1：await 归档落盘（失败上抛，本步隔离）
    } catch (e) {
      wbD(_archChatId ?? null, "backgroundTasks", "autoCheckArchiveTriggers:archiveForeverEntries", false, e.message, {});
      console.warn(`[beilu-memory] #8 永久记忆归档失败: ${e.message}`);
    }
  }

  // 检查 #9 是否有超过2天的条目（仅 chat）
  if (_chatArchEnabled && _archMode === "chat") {
    try {
      await maintainTimeSpaceTable(username, charName); // T1：await 归档落盘（失败上抛，本步隔离）
    } catch (e) {
      wbD(_archChatId ?? null, "backgroundTasks", "autoCheckArchiveTriggers:maintainTimeSpaceTable", false, e.message, {});
      console.warn(`[beilu-memory] #9 时空记忆维护失败: ${e.message}`);
    }
  }

  // ── chat 自定义表格行超限归档（泛化，设计 §2.1 + 决议3/决议7）──
  //   config.archive.table_archive = { [tableId]: {enabled, max_rows, keep_recent} }。
  //   ★默认关：table_archive 缺省=空 map=无表参与（chat 现状无表格归档，默认开=行为漂移，决议要求默认关）。
  //   只处理 chat 模式；每个 enabled 且超限的表调 archiveTableRowsGeneric（自身内部再判上限，触发器层只做粗筛）。
  //   guard `_archMode==="chat"`：与上方 #4/#7/#8/#9 同 guard，防 code/work 窗口误入。
  if (_chatArchEnabled && _archMode === "chat") {
    try {
      const _taCfg = data.config?.archive?.table_archive;
      if (_taCfg && typeof _taCfg === "object") {
        for (const [_tidStr, _entry] of Object.entries(_taCfg)) {
          if (!_entry || _entry.enabled === false) continue;
          const _tid = Number(_tidStr);
          if (!Number.isInteger(_tid)) continue;
          const _t = data.tables.find((t) => t.id === _tid);
          const _max = Number(_entry.max_rows) || TABLE_ARCHIVE_DEFAULTS.max_rows;
          if (_t && Array.isArray(_t.rows) && _t.rows.length > _max) {
            await archiveTableRowsGeneric(username, charName, "chat", _tid, _archChatId, {
              maxRows: _max,
              keepRecent: Number.isFinite(_entry.keep_recent) ? _entry.keep_recent : undefined,
              archiveBatch: Number.isFinite(_entry.archive_batch) ? _entry.archive_batch : undefined,
              minArchiveRows: Number.isFinite(_entry.min_archive_rows) ? _entry.min_archive_rows : undefined,
              fileNameTemplate: _entry.file_name_template,
            });
          }
        }
      }
    } catch (e) {
      wbD(_archChatId ?? null, "backgroundTasks", "autoCheckArchiveTriggers:chatTableArchive", false, e.message, {});
      console.warn(`[beilu-memory] chat 表格归档检查失败: ${e.message}`);
    }
  }

  // B7(20260610): warm→cold 自动驱动。此前 archiveWarmToCold 仅 UI 按钮/P5 手动调用 = 无周期触发器。
  // 挂进 autoCheckArchiveTriggers（replyHandler 每轮回复调用的统一归档触发器），但 warm→cold 是「天级」条件
  // （搬移 30 天前的 warm 月目录到 cold），故用 _config.json 的 _last_warm_cold_archive 日戳做「一天最多跑一次」闸，
  // 避免每轮回复重复扫盘。阈值沿用现有 config.archive.cold_archive_after_days（默认 30，archiveWarmToCold 内部读取）。
  try {
    const _memDir = getMemoryDir(username, charName);
    const _cfgPath = path.join(_memDir, "_config.json");
    // [20260726 并发修] 整段「读日戳 → 跑搬移 → 写日戳」进 withFileLock（键=该卡 _config.json）。
    //   病：两个窗口（如 airp + code）同时跑归档链时，各自 load 到同一个旧日戳 → 判断都成立 →
    //   **各跑一遍 warm→cold 搬移 + 各拍一次快照**，且后写的整份 _config.json 覆盖先写的
    //   （裸 saveJsonFile 是整份写回）→ 对方刚改的 active_modes_map / table_archive 配置被抹掉（lost-update）。
    //   日戳闸本身是幂等设计，但幂等要在串行下才成立——锁原语项目里早有（已用于 yonban_config），
    //   角色卡级 _config.json 漏接，属半接线不是设计取舍。
    await withFileLock(_cfgPath, async () => {
      const _cfg = loadJsonFileIfExists(_cfgPath, { enabled: true });
      const _today = getTodayStr();
      if (_cfg._last_warm_cold_archive === _today) return; // 锁内复检：并发的另一方已跑过
      // warm→cold 是删源搬移 → 搬移前归档域自动快照（日戳频控在 helper 内，与本闸天级同频）
      createArchiveSnapshot(username, charName, "warm→cold 月归档前自动快照");
      const _wcResult = archiveWarmToCold(username, charName);
      _cfg._last_warm_cold_archive = _today;
      saveJsonFile(_cfgPath, _cfg);
      if (_wcResult && _wcResult.moved > 0) {
        console.log(
          `[beilu-memory] warm→cold 自动归档：移动 ${_wcResult.moved} 个文件 (${charName})`,
        );
      }
    });
  } catch (e) {
    wbD(opts?.chatId ?? null, "backgroundTasks", "autoCheckArchiveTriggers:warmCold", false, e.message, {});
    console.warn(`[beilu-memory] warm→cold 自动归档失败: ${e.message}`);
  }

  // forever.json 字段规范化（缺 weight/last_triggered 的旧条目）
  normalizeForeverEntries(username, charName);
}

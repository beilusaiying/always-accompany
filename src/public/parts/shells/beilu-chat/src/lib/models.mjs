/**
 * beilu-chat 数据结构层
 * 包含：timeSlice_t、chatLogEntry_t、chatMetadata_t
 * 从 chat.mjs 拆分，不改变对外接口
 */

import { Buffer } from "node:buffer";
import fs from "node:fs";
import path from "node:path";
import { findLastActive as _findLastActive } from "../../../../../../yonban/core/functions/hide/chatEntryUtils.mjs"; // T8·回切：改指 yonban 新位实现体

import { createDiag } from "../../../../../../server/diagLogger.mjs";
import {
  getAllDefaultParts,
  getAnyDefaultPart,
  GetPartPath,
  loadPart,
} from "../../../../../../server/parts_loader.mjs";
import { addfile } from "../files.mjs";
import { wbTrace, wbSpan, wbDetect } from "../../../../../../server/whitebox.mjs";

const diag = createDiag("chat");

// 缓存已知 loadPart 失败的 world 路径，避免聊天历史中多条 timeSlice 反复触发同一个不存在的 world 加载告警
export const _failedWorldPaths = new Set();

// 已告警过的死链部件（partpath）：部件被删除后，历史聊天每条 timeSlice 都引用它，
// 同名死链只告警一次，避免 N 条历史 × 每条一次告警刷屏
const _missingPartWarned = new Set();

// 死链前置判定（与 parts_loader stale_entry_removed / 下方 stale_dropped 同 existsSync 判据）：
// 部件在盘上已不存在 → true，调用方跳过 dynamic import。否则部件删除后、聊天档未重存期间，
// 每条历史 timeSlice 都触发一次完整失败 import（千条聊天 = 千次 Module not found）= 后端加载慢主因。
// 判定异常按「存在」处理（瞬态），交给正常加载路径兜底。
function _partMissing(username, partpath) {
  try {
    if (!fs.existsSync(path.join(GetPartPath(username, partpath), "main.mjs"))) {
      if (!_missingPartWarned.has(partpath)) {
        _missingPartWarned.add(partpath);
        console.warn(`[chat] loadPart skipped: ${partpath} 部件已删除（同名死链不再逐条告警）`);
        wbDetect(null, "models", "loadPart:stale_skipped", false, "部件已删除，跳过加载", { partpath });
      }
      return true;
    }
  } catch { /* 判定失败按瞬态处理 */ }
  return false;
}

// ============================================================
// 数据结构：timeSlice_t（简化：去掉 chars_speaking_frequency）
// ============================================================

export class timeSlice_t {
  /** @type {Record<string, import('../../../../../../decl/charAPI.ts').CharAPI_t>} */
  chars = {};
  /** @type {Record<string, import('../../../../../../decl/pluginAPI.ts').PluginAPI_t>} */
  plugins = {};
  /** @type {import('../../../../../../decl/worldAPI.ts').WorldAPI_t} */
  world;
  /** @type {string} */
  world_id;
  /** @type {import('../../../../../../decl/userAPI.ts').UserAPI_t} */
  player;
  /** @type {string} */
  player_id;
  /** @type {Record<string, any>} */
  chars_memories = {};

  /** @type {Record<string, string>} loadPart 失败的角色及原因（运行期派生，不入 toJSON/toData，不持久化） */
  charLoadFailures = {};

  /** @type {string} 当前发言角色ID（临时） */
  charname;
  /** @type {string} 当前发言玩家ID（临时） */
  playername;
  /** @type {string} greeting 类型标记（临时，用于重新生成） */
  greeting_type;

  copy() {
    return Object.assign(new timeSlice_t(), this, {
      charname: undefined,
      playername: undefined,
      greeting_type: undefined,
      chars_memories: structuredClone(this.chars_memories),
    });
  }

  toJSON() {
    return {
      chars: Object.keys(this.chars),
      plugins: Object.keys(this.plugins),
      world: this.world_id,
      player: this.player_id,
      chars_memories: this.chars_memories,
      charname: this.charname,
    };
  }

  async toData() {
    return {
      chars: Object.keys(this.chars),
      plugins: Object.keys(this.plugins),
      world: this.world_id,
      player: this.player_id,
      chars_memories: this.chars_memories,
      charname: this.charname,
    };
  }

  static async fromJSON(json, username, dependencyCache) {
    if (!json) json = {};

    // 同一次聊天水化内，相同部件集合只加载一次；消息快照仍保持独立对象。
    if (dependencyCache) {
      const dependencies = [json.chars || [], json.plugins || [], json.world, json.player];
      const key = JSON.stringify(dependencies);
      let pending = dependencyCache.get(key);
      if (!pending) {
        pending = timeSlice_t.fromJSON({
          chars: dependencies[0], plugins: dependencies[1],
          world: dependencies[2], player: dependencies[3],
        }, username);
        dependencyCache.set(key, pending);
      }
      const loaded = await pending;
      return Object.assign(loaded.copy(), json, {
        chars: { ...loaded.chars }, plugins: { ...loaded.plugins },
        world: loaded.world, world_id: loaded.world_id,
        player: loaded.player, player_id: loaded.player_id,
        chars_memories: structuredClone(json.chars_memories || {}),
        charLoadFailures: { ...loaded.charLoadFailures },
      });
    }

    let worldLoadFailed = false;
    const charLoadFailures = {};
    const instance = Object.assign(new timeSlice_t(), {
      ...json,
      chars: Object.fromEntries(
        await Promise.all(
          (json.chars || []).map(async (charname) => {
            // 死链前置判定：角色已删除 → 跳过 import，仍记 charLoadFailures 供前端失败态渲染
            if (_partMissing(username, "chars/" + charname)) {
              charLoadFailures[charname] = "部件已删除";
              return [charname, undefined];
            }
            return [
              charname,
              await loadPart(username, "chars/" + charname).catch((e) => {
                console.warn(
                  `[chat] loadPart failed: chars/${charname}`,
                  e?.message || String(e),
                );
                wbDetect(null, "models", "loadPart:char:fail", false, e?.message || String(e), { charname });
                charLoadFailures[charname] = e?.message || String(e);
                return undefined;
              }),
            ];
          }),
        ),
      ),
      plugins: Object.fromEntries(
        (await Promise.all(
          (json.plugins || []).map(async (plugin) => {
            // 死链前置判定：部件已删除 → 跳过 import 直接剔键（由下方 filter 剔除，不写回聊天档）
            if (_partMissing(username, "plugins/" + plugin)) return null;
            return [
              plugin,
              await loadPart(username, "plugins/" + plugin).catch((e) => {
                console.warn(
                  `[chat] loadPart failed: plugins/${plugin}`,
                  e?.message || String(e),
                );
                wbDetect(null, "models", "loadPart:plugin:fail", false, e?.message || String(e), { plugin });
                return undefined;
              }),
            ];
          }),
        )).filter((pair) => {
          if (pair === null) return false; // 前置判定确认的死链
          const [plugin, part] = pair;
          if (part !== undefined) return true;
          // 2026-07-16 死链自续环根修：加载失败且部件已不存在（同 parts_loader
          //   stale_entry_removed 的 existsSync 判据）→ 从快照剔键——否则 toJSON 的
          //   Object.keys(this.plugins) 会把 undefined 键原样写回聊天档，死链永续。
          //   瞬态失败（目录仍在）保留键，不因一次加载失败丢用户数据。
          try {
            if (!fs.existsSync(path.join(GetPartPath(username, "plugins/" + plugin), "main.mjs"))) {
              wbDetect(null, "models", "loadPart:plugin:stale_dropped", false, "部件已删除，从 timeSlice 快照剔除", { plugin });
              return false;
            }
          } catch { /* 判定失败按瞬态处理，保留键 */ }
          return true;
        }),
      ),
      world_id: json.world || undefined,
      world: json.world
        ? _failedWorldPaths.has("worlds/" + json.world)
          ? ((worldLoadFailed = true), undefined)
          : await loadPart(username, "worlds/" + json.world).catch((e) => {
              console.warn(
                `[chat] loadPart failed: worlds/${json.world} — will clear world_id`,
                e?.message || String(e),
              );
              wbDetect(null, "models", "loadPart:world:fail", false, e?.message || String(e), { world: json.world });
              _failedWorldPaths.add("worlds/" + json.world);
              worldLoadFailed = true;
              return undefined;
            })
        : undefined,
      player_id: json.player,
      // 死链前置判定：人设已删除 → 跳过 import（player_id 保留，与加载失败时行为一致）
      player: json.player && !_partMissing(username, "personas/" + json.player)
        ? await loadPart(username, "personas/" + json.player).catch((e) => {
            console.warn(
              `[chat] loadPart failed: personas/${json.player}`,
              e?.message || String(e),
            );
            wbDetect(null, "models", "loadPart:player:fail", false, e?.message || String(e), { player: json.player });
            return undefined;
          })
        : undefined,
    });

    if (worldLoadFailed) {
      instance.world_id = undefined;
    }
    instance.charLoadFailures = charLoadFailures;
    for (const k of Object.keys(instance.chars)) {
      if (instance.chars[k] == null) delete instance.chars[k];
    }
    for (const k of Object.keys(instance.plugins)) {
      if (instance.plugins[k] == null) delete instance.plugins[k];
    }
    return instance;
  }
}

// ============================================================
// 数据结构：chatLogEntry_t（保留原样）
// ============================================================

export class chatLogEntry_t {
  /** @type {string} */
  id;
  name;
  avatar;
  time_stamp;
  role;
  content;
  content_for_show;
  content_for_edit;
  timeSlice = new timeSlice_t();
  files = [];
  extension = {};
  /** @type {boolean} */
  is_generating = false;
  /** @type {number} T009 P4：编辑版本号。editMessage 每次 +1，前端据此丢弃过期/回声广播（替代 5s 时序锁） */
  _editVersion = 0;

  constructor() {
    this.id = crypto.randomUUID();
  }

  toJSON() {
    return {
      ...this,
      timeSlice: this.timeSlice.toJSON(),
      files: this.files.filter(f => f.buffer).map((file) => ({
        ...file,
        buffer: Buffer.isBuffer(file.buffer)
          ? file.buffer.toString("base64")
          : file.buffer,
      })),
    };
  }

  async toData(username) {
    // [T042j] 同步快照后再异步序列化（读撕裂根修）：对象字面量属性按序求值，
    //   位于 await 悬挂点之后的 this.* 读取会与并发 editMessage 交错——原实现里
    //   files.filter/map 在 timeSlice await 之后才求值 = 标量@T0 + files@T1 字段级撕裂
    //   （链路：saveChat→chatStorage.mjs:302 await chatMetadata.toData()→本函数）。
    //   修法=同一微任务先取定标量（...this）与 files 浅快照，其后 await 只对快照工作；
    //   timeSlice_t.toData(:74) 体内无 await=原子，取定 T0 引用即可。
    //   Save Coalescing（chatStorage.mjs:277 _saveLocks）防写-写，本快照补防读-写。
    const _snap = { ...this };
    const _files = this.files.filter(f => f.buffer).map(f => ({ ...f }));
    return {
      ..._snap,
      // T009 字段契约（toData=消息流向前端的唯一出口，在此收口，下游无需再层层 || 保底）：
      //   content_for_edit 出口保证为字符串——编辑框永不拿到 undefined（B1-B4 病根之一）。
      //   content_for_show 是生成管线的渲染产物（replyHandler _stripAllTags→regex output_filter），
      //   无产物时显式置 null 而非 undefined——前端两库（本体/YonBan getDisplayHtml）据 null 走纯文本分支，渲染语义不变。
      //   不用 content 兜底 show：那会把所有用户消息从纯文本分支翻进 marked/HTML 分支（全局渲染行为变化）。
      content_for_show: _snap.content_for_show ?? null,
      content_for_edit: _snap.content_for_edit ?? _snap.content ?? "",
      timeSlice: await _snap.timeSlice.toData(),
      files: await Promise.all(
        _files.map(async (file) => ({
          ...file,
          buffer: typeof file.buffer === "string" && file.buffer.startsWith("file:")
            ? file.buffer
            : "file:" + (await addfile(username, file.buffer)),
        })),
      ),
    };
  }

  static async fromJSON(json, username, timeSliceCache) {
    const instance = Object.assign(new chatLogEntry_t(), {
      ...json,
      timeSlice: await timeSlice_t.fromJSON(json?.timeSlice, username, timeSliceCache),
      files: await Promise.all(
        (json.files || []).map(async (file) => ({
          ...file,
          buffer: file.buffer?.startsWith?.("file:")
            ? file.buffer
            : file.buffer ? Buffer.from(file.buffer, "base64") : null,
        })),
      ),
    });
    if (!instance.id) instance.id = crypto.randomUUID();
    return instance;
  }
}

// ============================================================
// 数据结构：chatMetadata_t（保留原样）
// ============================================================

export class chatMetadata_t {
  username;
  /** @type {chatLogEntry_t[]} */
  chatLog = [];
  /** @type {chatLogEntry_t[]} */
  timeLines = [];
  /** @type {number} */
  timeLineIndex = 0;
  /** @type {timeSlice_t} */
  LastTimeSlice = new timeSlice_t();
  /**
   * 已提交编辑操作的持久回执（仅协议元数据，不含正文/附件字节）。
   * chatOps 负责写入与限长；模型层负责随主聊天 JSON 原子保存和复制。
   * @type {Array<{operationId:string,payloadFingerprint:string,messageId:string,index:number,editVersion:number,committedAt:string}>}
   */
  editOperationReceipts = [];

  constructor(username) {
    this.username = username;
  }

  static async StartNewAs(username) {
    const metadata = new chatMetadata_t(username);

    metadata.LastTimeSlice.player_id = getAnyDefaultPart(username, "personas");
    if (metadata.LastTimeSlice.player_id)
      metadata.LastTimeSlice.player = await loadPart(
        username,
        "personas/" + metadata.LastTimeSlice.player_id,
      ).catch(e => { console.warn("[models] 默认人设加载失败:", metadata.LastTimeSlice.player_id, e?.message || e); });

    metadata.LastTimeSlice.world_id = getAnyDefaultPart(username, "worlds");
    if (metadata.LastTimeSlice.world_id)
      metadata.LastTimeSlice.world = await loadPart(
        username,
        "worlds/" + metadata.LastTimeSlice.world_id,
      ).catch(e => { console.warn("[models] 默认世界书加载失败:", metadata.LastTimeSlice.world_id, e?.message || e); });

    const _pluginPairs = await Promise.all(
      getAllDefaultParts(username, "plugins").map(async (plugin) => [
        plugin,
        await loadPart(username, "plugins/" + plugin).catch(e => { console.warn("[models] 插件加载失败:", plugin, e?.message || e); return null; }),
      ]),
    );
    metadata.LastTimeSlice.plugins = Object.fromEntries(
      _pluginPairs.filter(([, v]) => v != null),
    );

    return metadata;
  }

  toJSON() {
    const data = {
      username: this.username,
      chatLog: this.chatLog.map((log) => log.toJSON()),
      timeLines: this.timeLines.map((entry) => entry.toJSON()),
      timeLineIndex: this.timeLineIndex,
      editOperationReceipts: this.editOperationReceipts.map((receipt) => ({ ...receipt })),
    };
    // chatLog 非空时 LastTimeSlice 始终由最后一条有效消息的 timeSlice 派生，禁止再造第二份状态。
    // 但全新会话没有消息可承载角色/人设/世界书：若角色 first_mes 为空，addchar 只会更新
    // LastTimeSlice。旧格式此时保存一个空 chatLog，重载后角色挂载消失，bot 绑定随后稳定传播成
    // no_character。仅在空会话写入这份显式快照，使“无开场白角色”仍具备可持久化会话状态。
    if (this.chatLog.length === 0) data.emptyLastTimeSlice = this.LastTimeSlice.toJSON();
    return data;
  }

  async toData() {
    return {
      username: this.username,
      chatLog: await Promise.all(
        this.chatLog.map(async (log, i) => {
          if (typeof log?.toData === "function") {
            const result = await log.toData(this.username);
            // ★ DIAG P0: 检查 toData 输出是否有 id
            if (!result?.id) {
              wbDetect(null, "models", "chatMetadata.toData:missingId", false, "chatLog toData 输出缺少 id", { index: i, inputId: log?.id, ctor: log?.constructor?.name });
              diag.error(
                `chatLog[${i}] toData() 输出缺少 id!`,
                "input.id:",
                log?.id,
                "input.constructor:",
                log?.constructor?.name,
                "output keys:",
                result ? Object.keys(result).join(",") : "null",
              );
            }
            return result;
          }
          // ★ DIAG: 追踪纯对象来源
          diag.warn(
            `chatLog[${i}] missing toData method.`,
            "constructor:",
            log?.constructor?.name,
            "id:",
            log?.id,
            "role:",
            log?.role,
            "has toJSON:",
            typeof log?.toJSON === "function",
            "keys:",
            log ? Object.keys(log).join(",") : "null",
          );
          if (typeof log?.toJSON === "function") return log.toJSON();
          return log;
        }),
      ),
      timeLines: await Promise.all(
        this.timeLines.map(async (entry) => {
          if (typeof entry?.toData === "function")
            return entry.toData(this.username);
          console.warn(
            "[chat] timeLines entry missing toData method, using fallback",
          );
          if (typeof entry?.toJSON === "function") return entry.toJSON();
          return entry;
        }),
      ),
      timeLineIndex: this.timeLineIndex,
      editOperationReceipts: this.editOperationReceipts.map((receipt) => ({ ...receipt })),
    };
  }

  static async fromJSON(json) {
    // 生命周期仅限本次 JSON 水化：不新增全局缓存/状态所有者，调用结束即释放。
    const timeSliceCache = new Map();
    const chatLog = await Promise.all(
      json.chatLog.map(async (data, i) => {
        try {
          return await chatLogEntry_t.fromJSON(data, json.username, timeSliceCache);
        } catch (err) {
          wbDetect(null, "models", "chatLog:fromJSON:fallback", false, err?.message || String(err), { index: i, id: data?.id, role: data?.role });
          diag.error(
            `chatLog[${i}] fromJSON failed:`,
            err.message,
            "data keys:",
            data ? Object.keys(data).join(",") : "null",
            "id:",
            data?.id,
            "role:",
            data?.role,
          );
          // 构建最小有效 entry 防止崩溃
          const fallback = new chatLogEntry_t();
          fallback.id = data?.id || fallback.id;
          fallback.content = data?.content || `[加载失败: ${err.message}]`;
          fallback.role = data?.role || "system";
          fallback.name = data?.name || "System";
          fallback.time_stamp = data?.time_stamp || new Date();
          fallback.timeSlice = new timeSlice_t();
          return fallback;
        }
      }),
    );
    const timeLines = await Promise.all(
      json.timeLines.map(async (entry, i) => {
        try {
          return await chatLogEntry_t.fromJSON(entry, json.username, timeSliceCache);
        } catch (err) {
          wbDetect(null, "models", "timeLines:fromJSON:fallback", false, err?.message || String(err), { index: i, id: entry?.id });
          diag.error(`timeLines[${i}] fromJSON failed:`, err.message);
          const fallback = new chatLogEntry_t();
          fallback.id = entry?.id || fallback.id;
          fallback.content = entry?.content || `[加载失败: ${err.message}]`;
          fallback.role = entry?.role || "system";
          fallback.name = entry?.name || "System";
          fallback.time_stamp = entry?.time_stamp || new Date();
          fallback.timeSlice = new timeSlice_t();
          return fallback;
        }
      }),
    );

    // 清理上次崩溃残留的 generating 状态
    for (const entry of chatLog)
      if (entry.is_generating) entry.is_generating = false;
    for (const entry of timeLines)
      if (entry.is_generating) entry.is_generating = false;

    const persistedEmptyTimeSlice = chatLog.length === 0 && json.emptyLastTimeSlice
      ? await timeSlice_t.fromJSON(json.emptyLastTimeSlice, json.username)
      : new timeSlice_t();

    return Object.assign(new chatMetadata_t(), {
      username: json.username,
      chatLog,
      timeLines,
      timeLineIndex: json.timeLineIndex ?? 0,
      editOperationReceipts: Array.isArray(json.editOperationReceipts)
        ? json.editOperationReceipts
          .filter((receipt) => receipt && typeof receipt === "object" && !Array.isArray(receipt))
          .map((receipt) => ({ ...receipt }))
        : [],
      // 有消息时只信消息尾部；只有空会话才读取 emptyLastTimeSlice，避免双源漂移。
      LastTimeSlice: (_findLastActive(chatLog) || chatLog[chatLog.length - 1])?.timeSlice || persistedEmptyTimeSlice,
    });
  }

  copy() {
    return chatMetadata_t.fromJSON(this.toJSON());
  }
}

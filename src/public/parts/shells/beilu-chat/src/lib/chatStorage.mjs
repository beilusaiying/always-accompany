/**
 * chatStorage — 聊天持久化与缓存层。管聊天文件的读写、路径解析、摘要缓存、列表查询。
 * 不管消息 CRUD（那是 chatOps.mjs 的事）、不管 AI 生成（那是 generation.mjs 的事）。
 *
 * 链路：chatOps → saveChat（落盘）→ updateChatSummary → chat_summaries_cache / sendEventToUser(跨客户端同步)
 *       chatOps / requestBuilder / generation → loadChat（加载+缓存+跨 isolate 校验）
 *       endpoints → getChatList / deleteChat / branchChat / renameChat
 *
 * 影响：写 JSON 文件到 chars/{charName}/chats/{chatid}.json（新路径）或 shells/chat/chats/（旧路径兼容）
 *       写 chat_summaries_cache（shellData）、chat_names（shellData）
 *       sendEventToUser 跨客户端推 chat-list-changed（通道B: /ws/notify → onServerEvent）
 *       deleteChat 时清理 per-chatid 残留状态：7 个子系统（fileEditRegistry/ideClient/beilu-files/
 *       _saveLocks/broadcast/generation/groupWorkerManager）+ 角色卡级 active_modes_map/_work_config +
 *       preset/submode 映射 + 5 个 shellData 存储（chat_names/chat_modes/chat_flags/
 *       mode_active_chats/bot_chat_bindings），防单调泄漏
 *
 * 相交：← chatOps（saveChat 调用方）/ endpoints（CRUD 调用方）
 *       → json_loader（loadJsonFile/saveJsonFile）/ setting_loader（shellData）
 *       → event_dispatcher.sendEventToUser（跨客户端列表同步）
 *
 * 关键机制：
 *   Save Coalescing — 快速连续 saveChat 不并发写盘，后请求等前请求写完后 resave（用最新内存态）
 *   跨 isolate 缓存校验 — loadChat 按磁盘 mtime 比较，盘比缓存基线新则重载（worker 常驻复用场景）
 *   P0 路径自修复 — tryRepairChatPath 在预期路径找不到时探测旧路径/其他角色目录并回写 metadata
 *   _integrity — 每次写盘生成新 UUID，重载时校验磁盘 integrity 防外部改动冲突（冲突时备份 .conflict_）
 */

import fs from "node:fs";
import crypto from "node:crypto";
import { renameSyncWithRetry } from "../../../../../../scripts/nicerWriteFile.mjs";

import {
  loadJsonFile,
  loadJsonFileAsync, // [0719] loadChat 大文件热路径异步读（同严格语义），不阻塞事件循环
  saveJsonFile,
} from "../../../../../../scripts/json_loader.mjs";
import {
  getAllUserNames,
  getUserDictionary,
} from "../../../../../../yonban/core/functions/security/auth.mjs";
import { safeUnlink, throttledChatBackup } from "../../../../../../yonban/core/functions/rollback/safeDelete.mjs"; // T8·回切：改指 yonban 新位实现体
import { filterVisibleToUser } from "../../../../../../yonban/core/functions/hide/chatEntryUtils.mjs"; // T8·回切：改指 yonban 新位实现体
import {
  loadShellData,
  saveShellData,
} from "../../../../../../server/setting_loader.mjs";
// 跨客户端聊天列表同步：按 username 推 chat-list-changed 走通道B(sendEventToUser→/ws/notify→
// onServerEvent)。该通道由 server_events.mjs 直连 /ws/notify 复活（SW 删除后的框架级修复）。
import { sendEventToUser } from "../../../../../../server/web_server/event_dispatcher.mjs";

// bot 对话线标记符号（凛倾 07-09「对话文件的专门符号」）——后端单源。
// 0715 收口:定义原在 chatOps.mjs(它 import 本文件,反向引用成环故下沉此处),chatOps re-export 保旧调用点;
// 本文件 saveChat 摘要广播的 bot 判定原为 "🤖" 字面量副本,同批消除。前端镜像=shared/state/utils.mjs
// BOT_CHAT_SYMBOL(跨 runtime,改必同步两处)。
export const BOT_CHAT_SYMBOL = "🤖";

import { chatMetadata_t } from "./models.mjs";
import { wbTrace, wbSpan, wbDetect } from "../../../../../../server/whitebox.mjs";

// ============================================================
// 全局聊天元数据索引
// ============================================================

/** @type {Map<string, { username: string, primaryCharName: string, chatMetadata: chatMetadata_t | null }>} */
export const chatMetadatas = new Map();

/** 供 broadcast.mjs 通过注入方式访问（避免循环 import） */
export function getChatMetadatas() {
  return chatMetadatas;
}

// ============================================================
// 路径工具
// ============================================================

/**
 * 获取聊天存储目录路径
 * 新路径: chars/{primaryCharName}/chats/
 * 旧路径兼容: shells/chat/chats/（primaryCharName 为空时）
 */
export function getChatStorageDir(username, primaryCharName) {
  const userDir = getUserDictionary(username);
  if (primaryCharName) {
    return userDir + "/chars/" + primaryCharName + "/chats";
  }
  // 兼容旧路径
  return userDir + "/shells/chat/chats";
}

/**
 * P0 路径自修复：当预期路径找不到聊天文件时，探测备用路径并回写 metadata。
 */
export function tryRepairChatPath(username, chatid, currentPrimaryCharName) {
  const userDir = getUserDictionary(username);
  const chatFileName = chatid + ".json";

  // 1. 当前预期路径
  const currentDir = getChatStorageDir(username, currentPrimaryCharName || "");
  const currentPath = currentDir + "/" + chatFileName;
  if (fs.existsSync(currentPath)) return currentPath;

  // 2. 若当前指向新路径（有 primaryCharName），尝试旧路径
  if (currentPrimaryCharName) {
    const oldDir = userDir + "/shells/chat/chats";
    const oldPath = oldDir + "/" + chatFileName;
    if (fs.existsSync(oldPath)) {
      console.log(
        `[chat] 路径自修复: ${chatid} 在旧路径 shells/chat/chats/ 找到，回写 primaryCharName=""`,
      );
      const chatData = chatMetadatas.get(chatid);
      if (chatData) chatData.primaryCharName = "";
      return oldPath;
    }
  }

  // 3. 扫描所有角色目录
  const charsDir = userDir + "/chars/";
  if (fs.existsSync(charsDir)) {
    try {
      const charDirs = fs
        .readdirSync(charsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory());
      for (const charDir of charDirs) {
        if (charDir.name === currentPrimaryCharName) continue; // 已在步骤1检查过
        const scanPath = charsDir + charDir.name + "/chats/" + chatFileName;
        if (fs.existsSync(scanPath)) {
          console.log(
            `[chat] 路径自修复: ${chatid} 在 chars/${charDir.name}/chats/ 找到，回写 primaryCharName="${charDir.name}"`,
          );
          const chatData = chatMetadatas.get(chatid);
          if (chatData) chatData.primaryCharName = charDir.name;
          return scanPath;
        }
      }
    } catch (e) {
      console.warn(`[chat] 路径自修复扫描失败:`, e.message);
      wbDetect(chatid, "chatStorage", "tryRepairChatPath:scan:catch", false, e?.message || String(e), { currentPrimaryCharName });
    }
  }

  // 4. 若当前指向旧路径（无 primaryCharName），也尝试旧路径本身（防御性）
  if (!currentPrimaryCharName) {
    const oldDir = userDir + "/shells/chat/chats";
    const oldPath = oldDir + "/" + chatFileName;
    if (fs.existsSync(oldPath)) return oldPath;
  }

  return null; // 真正找不到
}

// ============================================================
// 初始化（启动时扫描磁盘）
// ============================================================

/**
 * 扫描磁盘建立 chatMetadatas 索引（幂等，只补未有项）。
 *
 * 链路：chat.mjs 启动时调用 / loadChat 自愈触发（worker isolate 场景）
 * 影响：扫描所有用户的 chars/ * /chats/ *.json + 旧路径 shells/chat/chats/ *.json
 *       旧路径聊天自动迁移到 chars/{charName}/chats/（从 chatLog 最后一条提取角色名）
 *
 * 迁移逻辑：读旧路径 JSON → 取 chatLog[-1].timeSlice.chars[0] 作 primaryCharName →
 *   renameSync 到新路径。提取失败则保留旧路径（primaryCharName=""）。
 */
/**
 * 模式指针/分类存量迁移（启动一次，per-user）。[批3 读路径纯化 0713 迁自 getChatList]
 * ① 化石键清理：`mode:`（角色段空）是 setModeActiveChat 收紧前的无主写入，值为 tab 联动
 *    飞行期错位对话（实测 002 用户四键整体轮转一位）——留着会污染 usedByModes 反查与回填归属。
 *    运行期不再新增（setModeActiveChat :923 拒空 char），清存量即绝版。
 * ② chat_modes 分类回填（凛倾「为什么不把模式的图标放到左边」）：chat_modes 生产链
 *    （classifyNewChat/MO-INIT→setChatMode）接线晚于存量对话创建，老对话永无分类徽章。
 *    per-char 在用指针=线归属权威，据它一次性回填；多模式指同一对话=归属歧义跳过不猜；
 *    已有分类不覆盖（用户/生产链写的优先）。新对话经 classifyNewChat 双写，无需运行期回填。
 * 【why 在启动】原两块住 getChatList 读路径=GET mutate loadShellData 共享缓存+落盘（读接口带
 *    持久化副作用，多源合并与反向回灌病型）。本函数与 :185 旧路径 chats/ 启动迁移同范式。
 */
function _migrateModePointerData(username) {
  try {
    const _modeActive = loadShellData(username, "chat", "mode_active_chats");
    const chatModes = loadShellData(username, "chat", "chat_modes");
    let _fossilPurged = false;
    for (const _k of Object.keys(_modeActive || {})) {
      if (!_k.split(":").slice(1).join(":").trim()) {
        delete _modeActive[_k];
        _fossilPurged = true;
      }
    }
    if (_fossilPurged) {
      try { saveShellData(username, "chat", "mode_active_chats"); } catch (e) { console.warn("[chatStorage] mode_active_chats 化石键清理落盘失败:", e?.message); }
    }
    const _claims = {};
    for (const [_k, _cid] of Object.entries(_modeActive || {})) {
      if (!_cid) continue;
      const _m = _k.split(":", 1)[0];
      (_claims[_cid] = _claims[_cid] || new Set()).add(_m);
    }
    let _modesDirty = false;
    for (const [_cid, _ms] of Object.entries(_claims)) {
      if (_ms.size !== 1 || chatModes[_cid]) continue;
      chatModes[_cid] = [..._ms][0];
      _modesDirty = true;
    }
    if (_modesDirty) {
      try { saveShellData(username, "chat", "chat_modes"); } catch (e) { console.warn("[chatStorage] chat_modes 回填落盘失败:", e?.message); }
    }
  } catch (e) {
    console.warn(`[chatStorage] 模式指针存量迁移失败（user=${username}，不阻断启动）:`, e?.message);
  }
}

// [0719 冷扫描节流] 本函数=全用户×全角色 readdirSync 递归扫盘+存量迁移检查（同步阻塞）。
//   原 loadChat 每次内存表 miss 都全量重跑——YonBan 切到未加载对话即触发秒级卡顿
//   （「点击对话要等很久」链上节点之一）。5s 节流：启动首扫必跑；正常链路新建对话由
//   createNewChat 直接入表不走 miss；罕见的外部手放文件场景最多延迟 5s 可见。
let _lastFullScanTs = 0;
export function initializeChatMetadatas() {
  const now = Date.now();
  if (now - _lastFullScanTs < 5000) return;
  _lastFullScanTs = now;
  const users = getAllUserNames();
  for (const user of users) {
    // [批3 读路径纯化 0713] 模式指针/分类存量迁移在启动跑一次（本函数=「启动扫描+存量迁移」
    //   的既有家，:185 旧路径 chats/ 迁移同范式）。原两块住 getChatList：读接口 mutate
    //   loadShellData 共享缓存+落盘=GET 带持久化副作用（多源合并与反向回灌病型服务端本体）。
    _migrateModePointerData(user);
    const userDir = getUserDictionary(user);
    const charsDir = userDir + "/chars/";
    if (!fs.existsSync(charsDir)) continue;

    // 扫描所有角色目录下的 chats/ 子目录
    const charDirs = fs
      .readdirSync(charsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory());
    for (const charDir of charDirs) {
      const chatsPath = charsDir + charDir.name + "/chats/";
      if (!fs.existsSync(chatsPath)) continue;

      const chatFiles = fs
        .readdirSync(chatsPath)
        .filter((file) => file.endsWith(".json"));
      for (const file of chatFiles) {
        const chatid = file.replace(".json", "");
        if (!chatMetadatas.has(chatid))
          chatMetadatas.set(chatid, {
            username: user,
            primaryCharName: charDir.name,
            chatMetadata: null,
          });
      }
    }

    // 兼容：扫描旧路径 shells/chat/chats/，自动迁移到 chars/{charName}/chats/
    const oldChatsDir = userDir + "/shells/chat/chats/";
    if (fs.existsSync(oldChatsDir)) {
      const chatFiles = fs
        .readdirSync(oldChatsDir)
        .filter((file) => file.endsWith(".json"));
      for (const file of chatFiles) {
        const chatid = file.replace(".json", "");
        if (chatMetadatas.has(chatid)) continue; // 新路径已有，跳过

        // 尝试从聊天文件中提取角色名，进行自动迁移
        const oldPath = oldChatsDir + file;
        let primaryCharName = "";
        try {
          const rawData = loadJsonFile(oldPath);
          // 从最后一条 chatLog 的 timeSlice.chars 提取第一个角色名
          const chatLog = rawData.chatLog || [];
          if (chatLog.length > 0) {
            const lastEntry = chatLog[chatLog.length - 1];
            const chars = lastEntry.timeSlice?.chars || [];
            if (Array.isArray(chars) && chars.length > 0) {
              primaryCharName = chars[0];
            }
          }
        } catch (e) {
          console.warn(`[chat] 读取旧聊天文件失败: ${oldPath}`, e.message);
        }

        if (primaryCharName) {
          // 迁移到新路径
          const newDir = userDir + "/chars/" + primaryCharName + "/chats";
          fs.mkdirSync(newDir, { recursive: true });
          const newPath = newDir + "/" + file;
          try {
            renameSyncWithRetry(oldPath, newPath);
            console.log(`[chat] 启动迁移: ${oldPath} → ${newPath}`);
            chatMetadatas.set(chatid, {
              username: user,
              primaryCharName,
              chatMetadata: null,
            });
          } catch (e) {
            console.warn(`[chat] 启动迁移失败: ${oldPath}`, e.message);
            chatMetadatas.set(chatid, {
              username: user,
              primaryCharName: "",
              chatMetadata: null,
            });
          }
        } else {
          // 无法提取角色名，保留在旧路径
          chatMetadatas.set(chatid, {
            username: user,
            primaryCharName: "",
            chatMetadata: null,
          });
        }
      }
    }
  }
}

// ============================================================
// Save Coalescing — 防止快速连续操作导致的写回竞态
// ============================================================
const _saveLocks = new Map(); // chatid → { saving: boolean, pendingResave: boolean, promise: Promise|null }

/**
 * 将对话内存态落盘（带 Save Coalescing 防竞态）。所有 chatOps 写操作的统一落盘出口。
 *
 * 链路：chatOps.addChatLogEntry/deleteMessage/editMessage/... → 本函数
 * 影响：写 JSON 文件 → 更新 _integrity + _loadedMtimeMs → throttledChatBackup → updateChatSummary
 *
 * Save Coalescing 机制：
 *   若已有保存正在进行（lock.saving=true），标记 lock.pendingResave=true 并等待当前保存完成。
 *   当前保存完成后检查 pendingResave，若 true 则用最新内存状态重新保存。
 *   这保证了快速连续操作（如批量删除）不会并发写盘导致数据丢失或损坏。
 *
 * @param {string} chatid
 */
export async function saveChat(chatid) {
  const chatData = chatMetadatas.get(chatid);
  if (!chatData || !chatData.chatMetadata) return;

  // 获取或创建该 chatid 的锁状态
  if (!_saveLocks.has(chatid)) {
    _saveLocks.set(chatid, {
      saving: false,
      pendingResave: false,
      promise: null,
    });
  }
  const lock = _saveLocks.get(chatid);

  if (lock.saving) {
    // 已有保存正在进行，标记需要重新保存（使用最新内存状态）
    lock.pendingResave = true;
    // 等待当前保存周期（含可能的 resave）完成
    if (lock.promise) await lock.promise;
    return;
  }

  lock.saving = true;
  lock.pendingResave = false;

  const doSave = async () => {
    // 每次保存都从 chatMetadatas 取最新数据（而非闭包捕获的旧快照）
    const freshData = chatMetadatas.get(chatid);
    if (!freshData || !freshData.chatMetadata) {
      lock.saving = false;
      return;
    }
    const { username, primaryCharName, chatMetadata } = freshData;
    const chatDir = getChatStorageDir(username, primaryCharName);
    fs.mkdirSync(chatDir, { recursive: true });
    const _chatPath = chatDir + "/" + chatid + ".json";
    const _wbSave = wbSpan(chatid, "chatStorage", "saveChat:write", { chatLogLen: chatMetadata.chatLog?.length || 0 });
    const _chatDataForSave = await chatMetadata.toData();
    // [2026-08-01 空消息累计案·断链2] "错误条目不持久化"契约的序列化单点兜底：
    //   generation.mjs finalizeEntry(isError) 打 _transient_error 标记的条目留在内存，
    //   任何落盘路径（本函数是唯一序列化点）一律剥除——旧实现只在 finalizeEntry 本次跳过
    //   saveChat，下一次任意写盘就把错误消息整份带上盘（自驱动2 案 idx2/idx4 实证）。
    if (Array.isArray(_chatDataForSave.chatLog)) _chatDataForSave.chatLog = _chatDataForSave.chatLog.filter(e => !e?._transient_error);
    if (Array.isArray(_chatDataForSave.timeLines)) _chatDataForSave.timeLines = _chatDataForSave.timeLines.filter(e => !e?._transient_error);
    if (fs.existsSync(_chatPath) && freshData._integrity) {
      try {
        const _diskRaw = JSON.parse(fs.readFileSync(_chatPath, "utf8"));
        if (_diskRaw._integrity && _diskRaw._integrity !== freshData._integrity) {
          console.warn(`[chat] integrity 冲突: chatid=${chatid}, 内存=${freshData._integrity}, 磁盘=${_diskRaw._integrity}（外部改动，仍保存）`);
          const _conflictPath = _chatPath + ".conflict_" + Date.now();
          // [2026-08-01 批⑤危险#2] 冲突备份失败不再静默吞——旧 catch{} 空体=备份失败后照常覆盖
          //   → 外部改动的聊天记录永久丢失且无备份无痕迹。现：失败留痕（wbDetect + warn 带路径）；
          //   仍继续覆盖（当前架构下不覆盖=本次生成结果丢失，两害相权取可诊断的那个）。
          try { fs.copyFileSync(_chatPath, _conflictPath); } catch (cpErr) {
            wbDetect(chatid, "chatStorage", "saveChat:conflict_backup_failed", false, `冲突备份失败(外部改动可能丢失): ${cpErr?.message}`, { conflictPath: _conflictPath });
            console.warn(`[chat] ⚠️ integrity 冲突备份失败: ${_conflictPath} — ${cpErr?.message}（仍将覆盖，外部改动可能丢失）`);
          }
        }
      } catch (intErr) {
      // 读盘校验失败不阻断保存，但留痕（原空 catch 零痕迹）
      console.warn(`[chat] integrity 校验读盘失败(沿用内存版覆盖): ${intErr?.message}`);
    }
    }
    const _newIntegrity = crypto.randomUUID();
    _chatDataForSave._integrity = _newIntegrity;
    freshData._integrity = _newIntegrity;
    saveJsonFile(_chatPath, _chatDataForSave);
    // 推进本 isolate 的缓存基线（债-B）：写盘方把自己的 mtime 基线对齐磁盘，
    //   使 loadChat 的跨 isolate 校验对「本进程自己的写」永不 spurious 重载（防丢未存内存改动）。
    try { freshData._loadedMtimeMs = fs.statSync(_chatPath).mtimeMs; freshData._filepath = _chatPath; } catch (e) { console.warn("[chatStorage] mtime 基线推进失败（仅退化为可能 spurious 重载）:", e?.message || e); /* T021 留痕 */ }
    _wbSave();
    try { throttledChatBackup(chatid, _chatDataForSave); } catch (e) { console.warn("[chatStorage] 对话节流备份失败（保存本身已成功）:", e?.message || e); /* T021 留痕 */ }
    await updateChatSummary(chatid, chatMetadata);

    // 检查保存期间是否有新的保存请求
    if (lock.pendingResave) {
      lock.pendingResave = false;
      await doSave(); // 使用最新内存状态重新保存
    } else {
      lock.saving = false;
    }
  };

  lock.promise = doSave().catch((err) => {
    console.error(`[chat] saveChat coalescing error for ${chatid}:`, err);
    wbDetect(chatid, "chatStorage", "saveChat:coalescing:catch", false, err?.message || String(err), null);
    lock.saving = false;
    lock.pendingResave = false;
  });

  await lock.promise;
}

/**
 * 加载对话（按 chatid 解析 chat 的单一权威）。带三级加载：内存缓存 → 磁盘加载 → 跨 isolate 校验。
 *
 * 链路：chatOps/requestBuilder/generation 的几乎所有函数 → 本函数
 * 影响：首次加载时从磁盘 JSON 反序列化（chatMetadata_t.fromJSON）并缓存；
 *       跨 isolate 场景按 mtime 检测磁盘更新并重载
 *
 * 跨 isolate 缓存校验机制（根因修复·债-B）：
 *   chatMetadatas 是 per-isolate Map，但权威是磁盘。worker 常驻 isolate 复用时，
 *   主进程写盘本 isolate 看不到 → 按磁盘 mtime 校验：盘比缓存基线新则重载。
 *   saveChat 写盘时同步推进 _loadedMtimeMs → 主进程此处永不 spurious 重载。
 *
 * 自愈机制：内存表未命中时触发 initializeChatMetadatas 扫盘补全（幂等），
 *   消除 loadChat 对调用方初始化时序的隐藏耦合。
 *
 * @param {string} chatid
 * @returns {Promise<chatMetadata_t|undefined>}
 */
export async function loadChat(chatid) {
  let chatData = chatMetadatas.get(chatid);
  if (!chatData) {
    // 自愈：内存表未命中 → 触发一次扫盘补全（幂等，只补未有项）再取。
    // 消除 loadChat 对「调用方必须先 initializeChatMetadatas()」的隐藏初始化耦合：
    //   ① worker isolate 走 requestBuilder→chatStorage，不经 chat.mjs（main 在那里扫表）→ 表恒空；
    //   ② 任何 worker boot 之后新建/新绑入的 chat（常驻组 worker 复用场景）原表也无此项。
    // loadChat 自此成为「按 chatid 解析 chat」的单一权威，不依赖调用上下文的初始化时序。
    initializeChatMetadatas();
    chatData = chatMetadatas.get(chatid);
    if (!chatData) return undefined;
  }

  // 解析磁盘路径（缓存到 chatData._filepath，避免每次重跑 tryRepairChatPath 的 fs 探测）
  let filepath = chatData._filepath;
  if (!filepath) {
    filepath = tryRepairChatPath(chatData.username, chatid, chatData.primaryCharName);
    if (filepath) chatData._filepath = filepath;
  }

  if (!chatData.chatMetadata) {
    if (!filepath) {
      wbDetect(chatid, "chatStorage", "loadChat:fileNotFound", false, "tryRepairChatPath 未找到聊天文件", { primaryCharName: chatData.primaryCharName });
      return undefined;
    }
    await _loadChatFromDisk(chatid, chatData, filepath, "loadChat:fromDisk");
  } else if (filepath) {
    // 跨 isolate 缓存校验（根因修复·债-B）：内存 chatMetadatas 是 per-isolate Map，但权威是磁盘。
    //   worker 常驻 isolate 复用时，主进程写盘（auto-continue 续轮 / 新用户消息）本 isolate 看不到 →
    //   原代码缓存后永不回盘 → worker 基于「冻结在首请求时刻」的对话重生成。
    //   按磁盘 mtime 校验：盘比缓存基线新则重载。saveChat 写盘时同步推进 _loadedMtimeMs，
    //   故主进程（唯一写盘方）此处 mtime 永不超基线 = 永不 spurious 重载，行为与原版等价。
    try {
      const m = fs.statSync(filepath).mtimeMs;
      if (chatData._loadedMtimeMs == null || m > chatData._loadedMtimeMs) {
        await _loadChatFromDisk(chatid, chatData, filepath, "loadChat:reloadStale");
      }
    } catch { /* stat 失败用现缓存，不阻断 */ }
  }
  return chatData.chatMetadata;
}

// [0719 异步化配套·装载单飞] loadChat 读盘从 readFileSync 改异步后出现并发窗口：同 chatid 并发
//   首访/重载会各自 fromJSON 再先后 set——后完成者替换 chatMetadata 引用，先完成者链上的 push
//   经 saveChat 再取表时写丢失。同 chatid 的读盘装载合并为单飞（in-flight Promise 共享，
//   与 parts_loader:486 同范式），不同 chatid 仍并行。装载态全写在共享 chatData 对象上，
//   等待方直接复用结果。
const _chatLoadInflight = new Map(); // chatid → Promise<void>
async function _loadChatFromDisk(chatid, chatData, filepath, wbLabel) {
  const existing = _chatLoadInflight.get(chatid);
  if (existing) { await existing; return; }
  const p = (async () => {
    const _wb = wbSpan(chatid, "chatStorage", wbLabel, { primaryCharName: chatData.primaryCharName });
    const _rawJson = await loadJsonFileAsync(filepath); // [0719] MB 级对话文件异步读（原 readFileSync 阻塞主线程=全请求排队）
    chatData.chatMetadata = await chatMetadata_t.fromJSON(_rawJson);
    chatData._integrity = _rawJson._integrity || null;
    try { chatData._loadedMtimeMs = fs.statSync(filepath).mtimeMs; } catch { chatData._loadedMtimeMs = 0; }
    _wb({ chatLogLen: chatData.chatMetadata?.chatLog?.length || 0 });
    chatMetadatas.set(chatid, chatData);
  })();
  _chatLoadInflight.set(chatid, p);
  try { await p; } finally { _chatLoadInflight.delete(chatid); }
}

// ============================================================
// 摘要（内部）
// ============================================================

function getSummaryFromMetadata(chatid, chatMetadata) {
  const _activeLog = filterVisibleToUser(chatMetadata?.chatLog);
  const lastEntry = _activeLog[_activeLog.length - 1];
  const firstUserEntry = _activeLog.find((e) => e.role === "user");
  const firstUserMessage = firstUserEntry?.content
    ? firstUserEntry.content
        .substring(0, 50)
        .replace(/[\n\r]+/g, " ")
        .trim()
    : "";
  if (!lastEntry) {
    return {
      chatid,
      chars: Object.keys(chatMetadata?.LastTimeSlice?.chars || {}),
      lastMessageSender: "",
      lastMessageSenderAvatar: null,
      lastMessageContent: "(新聊天)",
      lastMessageTime: new Date(),
      firstUserMessage,
    };
  }
  return {
    chatid,
    chars: Object.keys(chatMetadata?.LastTimeSlice?.chars || {}),
    lastMessageSender: lastEntry.name,
    lastMessageSenderAvatar: lastEntry.avatar || null,
    lastMessageContent: lastEntry.content,
    lastMessageTime: lastEntry.time_stamp,
    firstUserMessage,
  };
}

async function updateChatSummary(chatid, chatMetadata) {
  const { username } = chatMetadatas.get(chatid);
  if (!chatMetadata) chatMetadata = await loadChat(chatid);

  const summary = getSummaryFromMetadata(chatid, chatMetadata);
  const summariesCache = loadShellData(
    username,
    "chat",
    "chat_summaries_cache",
  );
  const prev = summariesCache[chatid];
  if (summary) summariesCache[chatid] = summary;
  else delete summariesCache[chatid];

  saveShellData(username, "chat", "chat_summaries_cache");

  // 跨客户端列表同步：摘要(最后一条预览)真变才推，避免每次落盘都发。
  // 通道B 按 username 投递，本体+YonBan 的会话列表收到后重渲染(防抖)。fire-and-forget。
  // bot 对话跳过（凛倾 07-09 其他链路核查）：bot 双写=每条平台消息一次 saveChat，若照推
  //   会让所有 web 端每条 bot 消息重拉重渲染列表——而 bot 对话本就被列表屏蔽（BOT_CHAT_SYMBOL），
  //   广播纯噪声。摘要缓存上方照常更新（bot 面板下拉打开时拉取仍新鲜）。
  const _isBotChat = (loadShellData(username, "chat", "chat_names")[chatid] || "").startsWith(BOT_CHAT_SYMBOL);
  const changed =
    !_isBotChat &&
    (!prev ||
    prev.lastMessageContent !== summary?.lastMessageContent ||
    String(prev.lastMessageTime) !== String(summary?.lastMessageTime));
  if (changed) {
    try { sendEventToUser(username, "chat-list-changed", { chatid }); } catch (e) { console.warn("[同步广播] chat-list-changed 推送失败(不阻塞落盘):", e?.message); }
  }
}

async function loadChatSummary(username, chatid, primaryCharName) {
  // P0 自修复：预期路径找不到时探测备用路径
  const filepath = tryRepairChatPath(username, chatid, primaryCharName || "");
  if (!filepath) return null;

  try {
    const rawChatData = loadJsonFile(filepath);
    // 处理空聊天（无消息）
    if (!rawChatData.chatLog || rawChatData.chatLog.length === 0) {
      return {
        chatid,
        chars: [],
        lastMessageSender: "",
        lastMessageSenderAvatar: null,
        lastMessageContent: "(新聊天)",
        lastMessageTime: new Date(),
      };
    }
    const _activeLog = filterVisibleToUser(rawChatData.chatLog);
    const lastEntry = _activeLog[_activeLog.length - 1] || rawChatData.chatLog[rawChatData.chatLog.length - 1];
    const chars = lastEntry.timeSlice?.chars || [];
    const firstUserEntry = _activeLog.find((e) => e.role === "user");
    const firstUserMessage = firstUserEntry?.content
      ? firstUserEntry.content
          .substring(0, 50)
          .replace(/[\n\r]+/g, " ")
          .trim()
      : "";
    return {
      chatid,
      chars,
      lastMessageSender: lastEntry.name || "Unknown",
      lastMessageSenderAvatar: lastEntry.avatar || null,
      lastMessageContent: lastEntry.content || "",
      lastMessageTime: new Date(lastEntry.time_stamp),
      firstUserMessage,
    };
  } catch (error) {
    console.error(`Failed to load summary for chat ${chatid}:`, error);
    return null;
  }
}

// ============================================================
// 聊天列表
// ============================================================

/**
 * 获取该用户的聊天列表（含摘要 + 自定义名 + 幽灵清理）。
 *
 * 链路：endpoints GET /getchatlist → 本函数
 * 影响：补充加载缺失摘要 → 清理幽灵摘要（磁盘文件不存在的条目）→ 注入 primaryCharName/customName
 *       幽灵清理同步写 summariesCache 和 chatMetadatas
 *
 * @param {string} username
 * @returns {Promise<Array<{ chatid, chars, lastMessageSender, lastMessageContent, lastMessageTime, firstUserMessage, primaryCharName, customName }>>}
 *   按 lastMessageTime 降序排列
 */
export async function getChatList(username) {
  const summariesCache = loadShellData(
    username,
    "chat",
    "chat_summaries_cache",
  );

  await Promise.all(
    Array.from(chatMetadatas.entries()).map(async ([chatid, value]) => {
      if (value.username === username) {
        // 旧缓存条目可能缺少 firstUserMessage 字段，需要补充加载
        const cached = summariesCache[chatid];
        if (!cached || cached.firstUserMessage === undefined) {
          summariesCache[chatid] = await loadChatSummary(
            username,
            chatid,
            value.primaryCharName,
          );
        }
      }
    }),
  );

  // P0 修复：清理幽灵摘要
  let ghostCleaned = 0;
  for (const chatid of Object.keys(summariesCache)) {
    if (!summariesCache[chatid]) {
      delete summariesCache[chatid];
      ghostCleaned++;
      continue;
    }
    const metaEntry = chatMetadatas.get(chatid);
    if (!metaEntry || metaEntry.username !== username) {
      delete summariesCache[chatid];
      ghostCleaned++;
      continue;
    }
    // 额外校验：磁盘文件是否真实存在
    const filepath = tryRepairChatPath(
      username,
      chatid,
      metaEntry.primaryCharName || "",
    );
    if (!filepath) {
      console.warn(
        `[chat] getChatList: 清理幽灵摘要 ${chatid}（磁盘文件不存在）`,
      );
      delete summariesCache[chatid];
      chatMetadatas.delete(chatid);
      ghostCleaned++;
    }
  }
  if (ghostCleaned > 0) {
    console.log(`[chat] getChatList: 清理了 ${ghostCleaned} 条幽灵摘要`);
    saveShellData(username, "chat", "chat_summaries_cache");
  }

  const chatList = Object.values(summariesCache).filter(Boolean);

  // 为每个摘要注入 primaryCharName（供前端过滤用）+ customName（N39 服务端持久改名）
  //   + mode（服务端持久模式徽标，chat_modes 权威；前端 localStorage convMeta.mode 只是缓存/兜底——
  //     旧方案 mode 只存 localStorage，换窗口/清缓存即全丢、列表徽标降级💬，故权威上移服务端）
  //   + inUseCount（该对话当前打开的 WS 连接数，broadcast.chatUiSockets 权威 → 前端「另一窗口在用」角标）
  const customNames = loadShellData(username, "chat", "chat_names");
  const chatModes = loadShellData(username, "chat", "chat_modes");
  // 收藏/置顶（chat_flags 权威，对齐 chat_names/chat_modes 范式；0715 多窗口审计 LS-4：
  //   原只存前端 localStorage convMeta——两窗口 read-modify-write 整对象互覆盖丢标记，权威上移服务端）
  const chatFlags = loadShellData(username, "chat", "chat_flags");
  // 「XX窗口在用」反查表：mode_active_chats(`${mode}:${char}`→chatid) 反转成 chatid→[mode,...]
  // [批3 读路径纯化 0713] 原化石键清理+chat_modes 回填两块存量迁移已迁 _migrateModePointerData
  //   （initializeChatMetadatas 启动一次）——本函数回归纯读，不再 mutate 共享缓存/落盘。
  //   化石键（角色段为空）此处只跳过不删（防御读：启动已清，运行期 setModeActiveChat :923 拒新增）。
  const _modeActive = loadShellData(username, "chat", "mode_active_chats");
  const _usedByMap = {};
  for (const [_k, _cid] of Object.entries(_modeActive || {})) {
    if (!_k.split(":").slice(1).join(":").trim()) continue;
    if (!_cid) continue;
    const _m = _k.split(":", 1)[0];
    (_usedByMap[_cid] = _usedByMap[_cid] || []).push(_m);
  }
  // 动态 import 防静态环（broadcast↔chatStorage 循环依赖，先例 :982 同款）
  let _connCount = null;
  try { _connCount = (await import("./broadcast.mjs")).getChatOpenConnCount; } catch { /* 广播层未就绪时降级 0 */ }
  for (const summary of chatList) {
    const metaEntry = chatMetadatas.get(summary.chatid);
    if (metaEntry) {
      summary.primaryCharName = metaEntry.primaryCharName || "";
    }
    summary.customName = customNames[summary.chatid] || "";
    summary.mode = chatModes[summary.chatid] || "";
    summary.starred = !!chatFlags[summary.chatid]?.starred;
    summary.pinned = !!chatFlags[summary.chatid]?.pinned;
    summary.usedByModes = _usedByMap[summary.chatid] || [];
    summary.inUseCount = _connCount ? _connCount(summary.chatid) : 0;
  }

  return chatList.sort(
    (a, b) => new Date(b.lastMessageTime) - new Date(a.lastMessageTime),
  );
}

// ============================================================
// 删除聊天
// ============================================================

/**
 * 删除聊天：磁盘文件 + 内存索引 + per-chatid 残留状态清理（7 个子系统 + 角色卡级映射 + 5 个 shellData 存储）。
 *
 * 链路：endpoints DELETE /delete → 本函数
 * 影响：safeUnlink 磁盘文件 → chatMetadatas.delete → 清理 7 个子系统 per-chatid 态：
 *   ① fileEditRegistry（编辑者注册表）② ideClient（编译熔断会话态）
 *   ③ beilu-files（activeModes/pendingOpResults/fileModeSessions）④ _saveLocks（写锁）
 *   ⑤ broadcast typingStatus ⑥ generation 续轮/计数/排队态 ⑦ groupWorkerManager（worker isolate）
 *   → 角色卡级 active_modes_map[chatid] + _work_config per-chat 键（跨所有角色卡目录遍历清理）
 *   → preset active_preset_map + yonban_config active_sub_modes_map 映射清理
 *   → summaries cache 清理 → _DEL_CLEAN_STORES 数据驱动清理 5 个 shellData 存储
 *     （chat_names/chat_modes/chat_flags 按键删，mode_active_chats/bot_chat_bindings 按值反查删）
 *   → sendEventToUser 跨客户端通知
 *
 * @param {string[]} chatids
 * @param {string} username
 * @returns {Promise<Array<{ chatid, success, message, error? }>>}
 */
export async function deleteChat(chatids, username) {
  const summariesCache = loadShellData(
    username,
    "chat",
    "chat_summaries_cache",
  );
  const deletePromises = chatids.map(async (chatid) => {
    try {
      const chatData = chatMetadatas.get(chatid);
      const primaryCharName = chatData?.primaryCharName || "";

      // P0 修复：删除时也走路径自修复，确保删到真实文件
      const filepath = tryRepairChatPath(username, chatid, primaryCharName);
      if (filepath) await safeUnlink(filepath, "deleteChat");

      // 额外清理：检查另一条路径是否有残留幽灵文件
      const userDir = getUserDictionary(username);
      const chatFileName = chatid + ".json";
      const oldPath = userDir + "/shells/chat/chats/" + chatFileName;
      const newPath = primaryCharName
        ? userDir + "/chars/" + primaryCharName + "/chats/" + chatFileName
        : null;
      for (const altPath of [oldPath, newPath]) {
        if (altPath && altPath !== filepath && fs.existsSync(altPath)) {
          try {
            await safeUnlink(altPath, "deleteChat_幽灵文件");
          } catch (_) {
            /* 忽略 */
          }
        }
      }

      chatMetadatas.delete(chatid);
      delete summariesCache[chatid];
      // 会话删除清理链（per-chatid 态防单调泄漏，发现1 同类批）：
      //   ① fileEditRegistry（81 文件编辑者注册表）② ideClient（_diagRepeat/_lastDiagSig 编译熔断会话态）
      //   ③ beilu-files（activeModes/pendingOpResults/fileModeSessions，经 SetData seam 不旁路）
      //   ④ 本模块 _saveLocks ⑤ broadcast typingStatus —— #85 同域漏网的 2 个同类，本轮补齐。
      //   ⑥ generation 续轮/计数/排队态（_autoContinueTimers/Counters/_fuzzyFailCounters/_pendingUserInput）——loop④ 审查补。
      try {
        const _fer = await import("../../../../../../scripts/fileEditRegistry.mjs");
        _fer.unregisterChat?.(chatid);
      } catch { /* 注册表不可用不影响删除 */ }
      try {
        const { ideClient } = await import("../../../../../../yonban/core/transport/ideClient.mjs");
        ideClient?.forgetChat?.(chatid);
      } catch { /* ideClient 不可用不影响删除 */ }
      try {
        const _filesMod = await import("../../../../plugins/beilu-files/main.mjs");
        const _filesSetData = _filesMod?.default?.interfaces?.config?.SetData;
        if (typeof _filesSetData === "function") await _filesSetData({ _action: "forgetChatState", chatid });
      } catch { /* beilu-files 不可用不影响删除 */ }
      // ④ 本模块 _saveLocks（saveChat coalescing 锁，只置 saving=false 从不 delete）——直删本会话键。
      _saveLocks.delete(chatid);
      try {
        // ⑤ broadcast typingStatus 外层 chatid 键（内层自清、外层空 Map 永留）——经导出清理函数。
        const _bc = await import("./broadcast.mjs");
        _bc.forgetChatTyping?.(chatid);
      } catch { /* broadcast 不可用不影响删除 */ }
      try {
        // ⑥ generation per-chatid 续轮/计数/排队态（防异常路径泄漏 + 防 timer 在已删会话 fire）。
        const _gen = await import("./generation.mjs");
        _gen.forgetChatGenState?.(chatid);
      } catch { /* generation 不可用不影响删除 */ }
      try {
        // ⑦ 一窗一线：未绑组的 per-线 worker isolate 以 chatid 为键，删会话时终止防 isolate 泄漏。
        //   绑组的 worker 键=groupId（删组时终止），按 chatid 终止对其为 no-op，互不影响。
        const _gwm = await import("./groupWorkerManager.mjs");
        _gwm.terminateGroupWorker?.(chatid);
      } catch { /* worker 网关不可用不影响删除 */ }
      try {
        // ⑧ 【20260726 删】原此处删 {code,work}_ctx/<chatId>/ —— 那是「删对话＝删该对话的记忆」，
        //   随「按对话切分」维度一并根除：记忆归角色卡，删聊天记录不得带走表格/经验/任务。
        //   （凛倾定案：隔离只有用户级+角色卡级，对话不是维度；getModeCtxDir 已恒角色卡级。）
        //   本 try 块保留：下面的 active_modes_map / _work_config per-chat 键才是真·会话残键，仍需清。
        const _path = await import("node:path");
        const _charsRoot = _path.join((await import("../../../../../../yonban/core/functions/memory/storage_mod/storage.mjs")).getUserDataDir(username), "chars");
        if (fs.existsSync(_charsRoot)) {
          for (const _char of fs.readdirSync(_charsRoot)) {
            // ⑨-c 卡级 _config.json active_modes_map[chatid]（per-chatId 模式绑定残键，getActiveMode 消费同口径）
            try {
              const _ccPath = _path.join(_charsRoot, _char, "memory", "_config.json");
              if (fs.existsSync(_ccPath)) {
                const _cc = JSON.parse(fs.readFileSync(_ccPath, "utf-8"));
                if (_cc?.active_modes_map && _cc.active_modes_map[chatid] !== undefined) {
                  delete _cc.active_modes_map[chatid];
                  const { saveJsonFile: _sjf } = await import("../../../../../../yonban/core/functions/memory/storage_mod/storage.mjs");
                  _sjf(_ccPath, _cc);
                }
              }
            } catch { /* 单卡 map 清理失败不阻断其他卡 */ }
            // ⑨-d 卡级 _work_config per-chat 键（0722 每窗独立链路：selected_groups_map[chatid] 窗口层
            //   选中组 + workflows[chatid] 运行槽，"_default" 层/槽不清；helper 内走 updateWorkConfig 串行锁）
            try {
              const { removeChatWorkConfigMappings } = await import("../../../../../../yonban/core/functions/memory/storage_mod/storage.mjs");
              await removeChatWorkConfigMappings(username, _char, chatid);
            } catch { /* 单卡 work_config 键清理失败不阻断其他卡 */ }
          }
        }
      } catch { /* ctx 清理失败不影响删除主流程（下次删除会再试同目录） */ }
      try {
        // ⑨ 删聊天清理链补站（07-03，孤儿复扫实证映射残键）：per-chatId 元数据映射——
        //   a) preset active_preset_map（config.json+内存态双清） b) yonban_config active_sub_modes_map
        //   c) 卡级 active_modes_map（上方跨卡循环内顺路）。chat_names 清理既有（本文件 N39 区）。
        const { removeChatPresetMapping } = await import("../../../../../../yonban/core/functions/prompt/preset/main.mjs");
        await removeChatPresetMapping(username, chatid); // [T065] active_preset_map 已 per-user，删聊天清映射需带 username 定位其 config；[缺口⑦ 2026-07-16] async 化后 await（内部走 withFileLock 串 config.json read-modify-write）
        const { removeChatSubModeMapping } = await import("../../../../../../yonban/core/functions/memory/storage_mod/storage.mjs");
        await removeChatSubModeMapping(username, chatid); // T4：now async（走 updateYonbanConfig 串行锁），await 保留错误被本 try/catch 捕获
      } catch { /* 映射清理失败不影响删除主流程 */ }
      return { chatid, success: true, message: "Chat deleted successfully" };
    } catch (error) {
      console.error(`Error deleting chat ${chatid}:`, error);
      return {
        chatid,
        success: false,
        message: "Error deleting chat",
        error: error.message,
      };
    }
  });

  const results = await Promise.all(deletePromises);
  saveShellData(username, "chat", "chat_summaries_cache");
  // per-chatid 附属 store 卫生清理（0715 散点合并：原 5 段同构手抄块收成数据驱动两形状——
  //   keyed=chatid 作键的映射（chat_names/chat_modes/chat_flags 按键删）、
  //   valued=chatid 作值的指针表（mode_active_chats/bot_chat_bindings 值域反查删）。
  //   新增 per-chatid store 只在此登记一行，不再手抄第 6 段（防质量不齐副本累积）。
  //   bot_chat_bindings 读侧另有 ensureBotChat 存在性自愈（凛倾 07-09），此处是写侧卫生。
  const _DEL_CLEAN_STORES = [
    { store: "chat_names", by: "key" },
    { store: "chat_modes", by: "key" },
    { store: "chat_flags", by: "key" },
    { store: "mode_active_chats", by: "value" },
    { store: "bot_chat_bindings", by: "value" },
  ];
  for (const { store, by } of _DEL_CLEAN_STORES) {
    const _map = loadShellData(username, "chat", store);
    let _dirty = false;
    if (by === "key") {
      for (const chatid of chatids) {
        if (_map[chatid] !== undefined) { delete _map[chatid]; _dirty = true; }
      }
    } else {
      for (const [_k, _v] of Object.entries(_map || {})) {
        if (chatids.includes(_v)) { delete _map[_k]; _dirty = true; }
      }
    }
    if (_dirty) saveShellData(username, "chat", store);
  }
  // 跨客户端列表同步：删除后通知该用户所有端(本体+YonBan)重渲染列表，移除已删项。
  try { sendEventToUser(username, "chat-list-changed", { deleted: chatids }); } catch (e) { console.warn("[同步广播] chat-list-changed(deleted) 推送失败(不阻塞删除):", e?.message); }
  return results;
}

// ============================================================
// N39 对话改名（服务端持久化；设计 IDE模式_界面设计.md :262）
// 存储 = 每用户 shellData "chat_names"（chatid→自定义名）。
// 不写 chat 文件本体：chatMetadata_t 类控制 toData() 序列化，外挂字段会被丢；
// 不写 summaries 缓存：它是派生缓存，ghost 清理/重建会丢名字。
// 空名 = 删除映射，回退默认名（首条用户消息）。deleteChat 已同步清键。
// ============================================================

export async function renameChat(chatid, username, name) {
  const meta = chatMetadatas.get(chatid);
  if (!meta || meta.username !== username) {
    return { success: false, message: "chat 不存在或不属于当前用户" };
  }
  const names = loadShellData(username, "chat", "chat_names");
  const trimmed = String(name ?? "").trim().substring(0, 100);
  if (trimmed) names[chatid] = trimmed;
  else delete names[chatid];
  saveShellData(username, "chat", "chat_names");
  // 跨客户端列表同步：改名后通知该用户所有端重渲染列表，显示新名。
  try { sendEventToUser(username, "chat-list-changed", { chatid, renamed: true }); } catch (e) { console.warn("[同步广播] chat-list-changed(renamed) 推送失败(不阻塞改名):", e?.message); }
  return { success: true, chatid, name: trimmed };
}

// ============================================================
// 对话模式徽标（服务端持久化，对齐 N39 chat_names 范式）
// 存储 = 每用户 shellData "chat_modes"（chatid→模式名）。
// 【why】模式徽标原只存前端 localStorage convMeta.mode：换窗口/清缓存即全丢、
//   旧对话列表全降级💬无法区分。权威上移服务端，前端 localStorage 降级为缓存。
// 空值 = 删除映射（回到无徽标）。deleteChat 已同步清键。
// ============================================================

// 概念域澄清(0715 审计核验):本集=【窗口模式徽标域】(凛倾 0712「一共4个模式」的四个 UI 窗口),
//   与 yonban storage.mjs _validModeIds=【生成/注入模式域】(五内置含 bot+动态注册自定义)是两个概念域——
//   bot 线被列表屏蔽不走徽标,故刻意不含 "bot",两集共享 4 值≠同一清单,禁互相"补齐"合并(枚举概念域教训)。
const _VALID_CHAT_MODES = new Set(["chat", "smart", "code", "work"]); // [0724] smart 回归（002:「用以前的全智能模式」，0723 删除撤销——「在用」指针保存失败:无效模式 smart 案）

export async function setChatMode(chatid, username, mode) {
  const meta = chatMetadatas.get(chatid);
  if (!meta || meta.username !== username) {
    return { success: false, message: "chat 不存在或不属于当前用户" };
  }
  const trimmed = String(mode ?? "").trim();
  if (trimmed && !_VALID_CHAT_MODES.has(trimmed)) {
    return { success: false, message: `无效模式: ${trimmed}` };
  }
  const modes = loadShellData(username, "chat", "chat_modes");
  if (trimmed) modes[chatid] = trimmed;
  else delete modes[chatid];
  saveShellData(username, "chat", "chat_modes");
  // 跨客户端列表同步：徽标变更后通知该用户所有端重渲染列表（与 rename 同事件，前端监听已就位）
  try { sendEventToUser(username, "chat-list-changed", { chatid, modeChanged: true }); } catch (e) { console.warn("[同步广播] chat-list-changed(mode) 推送失败(不阻塞):", e?.message); }
  return { success: true, chatid, mode: trimmed };
}

// ============================================================
// 收藏/置顶标记（服务端持久化，对齐 chat_names/chat_modes 范式）
// 存储 = 每用户 shellData "chat_flags"（chatid→{starred,pinned}）。
// 【why · 0715 多窗口审计 LS-4】starred/pinned 原只存前端 localStorage convMeta——
//   整对象 read-modify-write：两窗口同时改不同对话，后写者覆盖先写者=标记静默丢；
//   且换浏览器/清缓存全丢。权威上移服务端（per-chatid 单键写，服务端单线程处理天然无竞态），
//   前端 convMeta.starred/pinned 降级为缓存/离线兜底（与 customName/mode 同构）。
// 两键全 false = 删除映射（卫生，不留空壳键）。deleteChat 已同步清键。
// ============================================================

export async function setChatFlags(chatid, username, flags) {
  const meta = chatMetadatas.get(chatid);
  if (!meta || meta.username !== username) {
    return { success: false, message: "chat 不存在或不属于当前用户" };
  }
  const all = loadShellData(username, "chat", "chat_flags");
  const cur = { ...(all[chatid] || {}) };
  if (flags && flags.starred !== undefined) cur.starred = !!flags.starred;
  if (flags && flags.pinned !== undefined) cur.pinned = !!flags.pinned;
  if (cur.starred || cur.pinned) all[chatid] = cur;
  else delete all[chatid];
  saveShellData(username, "chat", "chat_flags");
  // 跨客户端列表同步（与 rename/mode 同事件，前端监听已就位）
  try { sendEventToUser(username, "chat-list-changed", { chatid, flagsChanged: true }); } catch (e) { console.warn("[同步广播] chat-list-changed(flags) 推送失败(不阻塞):", e?.message); }
  return { success: true, chatid, starred: !!cur.starred, pinned: !!cur.pinned };
}

// ============================================================
// 「哪个模式窗口正在使用哪个对话文件」（服务端持久化，对齐 chat_modes 范式）
// 存储 = 每用户 shellData "mode_active_chats"（`${mode}:${charName}` → chatid）。
// 【why】模式线当前对话指针原只存前端 localStorage（getModeChatIdKey per-char key）——
//   单浏览器视角，换窗口后「XX窗口在用」标签残缺（凛倾 0712「一共4个模式为什么只有两个」）。
//   权威上移服务端：getChatList 给每条对话注入 usedByModes，各端列表一致。
// 键的 char 段 = 服务端反查对话 primaryCharName（R1 0713），前端不再报送 charName——
//   前端 charName 源（BEILU_LAST_CHAR）只在 charsel 选卡路径写，init/切换路径常为空，
//   「前端跳闸+此处拒收」双闸全静默 → 指针冻结在旧值（0713「在用」徽标硬编码案根因）。
//   char≡primaryCharName 本就是本键的投影安全前提（前端读时校准依赖它），报送是冗余信息源。
// deleteChat 同步清指向被删对话的键（:847 值域反查）。原「空 chatid=删指针」分支已删：
//   路由参数 :chatid 必非空，该分支零生产者，且 R1 后无 chatid 无从反查 char 定键。
// ============================================================

export async function setModeActiveChat(chatid, username, mode) {
  const trimmedMode = String(mode ?? "").trim();
  if (!_VALID_CHAT_MODES.has(trimmedMode)) {
    return { success: false, message: `无效模式: ${trimmedMode}` };
  }
  const meta = chatMetadatas.get(chatid);
  if (!meta || meta.username !== username) {
    return { success: false, message: "chat 不存在或不属于当前用户" };
  }
  const trimmedChar = String(meta.primaryCharName ?? "").trim();
  // 指针按「模式×角色」分线，无归属角色的对话无法定键（防 `mode:` 化石键复发，0713 根修沿承）。
  if (!trimmedChar) {
    return { success: false, message: "对话无归属角色（primaryCharName 空），模式在用指针按角色分线，无法定键" };
  }
  const key = `${trimmedMode}:${trimmedChar}`;
  const map = loadShellData(username, "chat", "mode_active_chats");
  if (map[key] === chatid) return { success: true, chatid, mode: trimmedMode, unchanged: true }; // 幂等：高频切换不重复写盘/广播
  map[key] = chatid;
  saveShellData(username, "chat", "mode_active_chats");
  // 「在用」标签跨端刷新（与 rename/mode 同事件，前端防抖监听已就位）
  try { sendEventToUser(username, "chat-list-changed", { chatid, modeActiveChanged: true }); } catch (e) { console.warn("[同步广播] chat-list-changed(modeActive) 推送失败(不阻塞):", e?.message); }
  return { success: true, chatid, mode: trimmedMode };
}

// ============================================================
// 导出聊天
// ============================================================

export async function exportChat(chatids) {
  const exportPromises = chatids.map(async (chatid) => {
    try {
      const chat = await loadChat(chatid);
      if (!chat)
        return {
          chatid,
          success: false,
          message: "Chat not found",
          error: "Chat not found",
        };
      return { chatid, success: true, data: chat };
    } catch (error) {
      console.error(`Error exporting chat ${chatid}:`, error);
      return {
        chatid,
        success: false,
        message: "Error exporting chat",
        error: error.message,
      };
    }
  });
  return Promise.all(exportPromises);
}

// ============================================================
// 按角色名查询聊天 ID
// ============================================================

export function getChatIdsByCharName(username, charName) {
  const ids = [];
  for (const [chatid, data] of chatMetadatas.entries()) {
    if (data.username === username && data.primaryCharName === charName) {
      ids.push(chatid);
    }
  }
  return ids;
}

// ============================================================
// 新建聊天 CRUD（保留在此层）
// ============================================================

export async function newMetadata(chatid, username) {
  chatMetadatas.set(chatid, {
    username,
    primaryCharName: "",
    chatMetadata: await chatMetadata_t.StartNewAs(username),
  });
}

export function findEmptyChatid() {
  while (true) {
    const uuid = Math.random().toString(36).substring(2, 15);
    if (!chatMetadatas.has(uuid)) return uuid;
  }
}

export async function newChat(username, mode) {
  const chatid = findEmptyChatid();
  await newMetadata(chatid, username);
  await saveChat(chatid);
  // [0730] YonBan 等非本体前端创建对话时可指定模式，后端自动 setChatMode（原只有前端 classifyNewChat 写标签=非本体入口恒缺标签）。
  if (mode && _VALID_CHAT_MODES.has(mode)) {
    await setChatMode(chatid, username, mode);
  }
  return chatid;
}

/**
 * 对话分叉：从源对话的指定消息处创建分支副本。
 * 采用磁盘级 JSON 截断方案——直接读源 JSON → 截断 chatLog → 清空 timeLines → 写新文件，
 * 跳过 fromJSON 反序列化（避免 loadPart 开销）。
 *
 * @param {string} sourceChatid - 源对话 ID
 * @param {number} branchPointIndex - 分叉点（保留 chatLog[0..branchPointIndex]，含此条）
 * @param {string} username - 当前用户名（用于鉴权 + 存储路径）
 * @returns {Promise<string>} 新对话的 chatid
 */
export async function branchChat(sourceChatid, branchPointIndex, username) {
  // 1. 查源对话元信息
  const sourceData = chatMetadatas.get(sourceChatid);
  if (!sourceData) throw new Error("源对话不存在");
  if (sourceData.username !== username) throw new Error("无权操作此对话");

  // 2. 解析源文件磁盘路径
  let sourceFilepath = sourceData._filepath;
  if (!sourceFilepath) {
    sourceFilepath = tryRepairChatPath(username, sourceChatid, sourceData.primaryCharName);
    if (!sourceFilepath) throw new Error("源对话磁盘文件未找到");
  }

  // 3. 读源 JSON（纯 JSON 对象，不走 fromJSON 反序列化）
  const rawJson = loadJsonFile(sourceFilepath);
  if (!Array.isArray(rawJson.chatLog) || rawJson.chatLog.length === 0) {
    throw new Error("源对话为空，无法分叉");
  }
  if (branchPointIndex < 0 || branchPointIndex >= rawJson.chatLog.length) {
    throw new Error(`分叉点越界: ${branchPointIndex}，有效范围 0-${rawJson.chatLog.length - 1}`);
  }

  rawJson.chatLog = filterVisibleToUser(rawJson.chatLog.slice(0, branchPointIndex + 1));
  rawJson.timeLines = [];
  rawJson.timeLineIndex = 0;

  // 5. 生成新 chatid + 写盘
  const newChatid = findEmptyChatid();
  const primaryCharName = sourceData.primaryCharName || "";
  const chatDir = getChatStorageDir(username, primaryCharName);
  fs.mkdirSync(chatDir, { recursive: true });
  const newFilepath = chatDir + "/" + newChatid + ".json";
  saveJsonFile(newFilepath, rawJson);

  // 6. 注册到 chatMetadatas Map（chatMetadata 置 null，首次 loadChat 时从盘懒加载）
  chatMetadatas.set(newChatid, {
    username,
    primaryCharName,
    chatMetadata: null,
    _filepath: newFilepath,
  });

  // 7. 自动命名：「分支 - 源对话名/首条用户消息 - 时间」
  const names = loadShellData(username, "chat", "chat_names");
  const sourceName = names[sourceChatid] || "";
  const timeStr = new Date().toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  names[newChatid] = `分支 - ${sourceName || sourceChatid.substring(0, 8)} - ${timeStr}`;
  saveShellData(username, "chat", "chat_names");

  // 8. 更新摘要缓存 + 跨客户端同步
  const summariesCache = loadShellData(username, "chat", "chat_summaries_cache");
  const lastEntry = rawJson.chatLog[rawJson.chatLog.length - 1];
  const firstUserEntry = rawJson.chatLog.find((e) => e.role === "user");
  const firstUserMessage = firstUserEntry?.content
    ? firstUserEntry.content.substring(0, 50).replace(/[\n\r]+/g, " ").trim()
    : "";
  summariesCache[newChatid] = {
    chatid: newChatid,
    chars: Object.keys(lastEntry?.timeSlice?.chars || {}),
    lastMessageSender: lastEntry?.name || "",
    lastMessageSenderAvatar: lastEntry?.avatar || null,
    lastMessageContent: lastEntry?.content || "",
    lastMessageTime: lastEntry?.time_stamp || new Date(),
    firstUserMessage,
  };
  saveShellData(username, "chat", "chat_summaries_cache");

  // 通知跨客户端列表刷新
  try { sendEventToUser(username, "chat-list-changed", { chatid: newChatid }); } catch (e) { console.warn("[同步广播] chat-list-changed(branch) 推送失败(不阻塞):", e?.message); }

  return newChatid;
}

// ============================================================
// 事件处理器（用户删除 / 改名）
// 注：events 需在 chat.mjs facade 中引入后调用这些处理器
// ============================================================

export async function handleAfterUserDeleted({ username }) {
  const chatIdsToDelete = [];
  for (const [chatId, data] of chatMetadatas.entries())
    if (data.username === username) chatIdsToDelete.push(chatId);

  for (const chatId of chatIdsToDelete) {
    // 系统级会话终结（D-删号卡死根修，20260706）：删除用户=系统事件，在状态清理前主动向该用户
    //   所有在场窗口推 account_deleted 并关闭 WS——前端 websocket.mjs handleBroadcastEvent 既有
    //   同名分支（清 beilu-* 存储+回登录页）即刻活化。按用户/系统推送踢出，不依赖各浏览器
    //   请求自行撞 401（notify 通道的 event_dispatcher AfterUserDeleted 只覆盖 pages 层，壳在此补齐）。
    try {
      const m = await import("./broadcast.mjs");
      m.broadcastChatEvent?.(chatId, { type: "account_deleted" });
      for (const ws of (m.chatUiSockets?.get(chatId) || [])) { try { ws.close(1000, "account deleted"); } catch { /* */ } }
      m.chatUiSockets?.delete(chatId);
    } catch { /* */ }
    chatMetadatas.delete(chatId);
    _saveLocks.delete(chatId);
    try { const m = await import("../../../../../../scripts/fileEditRegistry.mjs"); m.unregisterChat?.(chatId); } catch { /* */ }
    try { const { ideClient } = await import("../../../../../../yonban/core/transport/ideClient.mjs"); ideClient?.forgetChat?.(chatId); } catch { /* */ }
    try { const m = await import("../../../../plugins/beilu-files/main.mjs"); const sd = m?.default?.interfaces?.config?.SetData; if (typeof sd === "function") await sd({ _action: "forgetChatState", chatid: chatId }); } catch { /* */ }
    try { const m = await import("./broadcast.mjs"); m.forgetChatTyping?.(chatId); } catch { /* */ }
    try { const m = await import("./generation.mjs"); m.forgetChatGenState?.(chatId); } catch { /* */ }
    try { const m = await import("./groupWorkerManager.mjs"); m.terminateGroupWorker?.(chatId); } catch { /* */ }
  }
}

// 注意：handleAfterUserRenamed 是同步函数但调 saveChat（async）不 await——fire-and-forget。
// 如果改名期间并发操作同一 chatId，saveChat coalescing 机制会保护最终一致性，但改名完成回调
// 返回时落盘可能尚未完成。当前事件处理框架不 await 结果，这是已知设计取舍。
export function handleAfterUserRenamed({ oldUsername, newUsername }) {
  for (const [chatId, data] of chatMetadatas.entries())
    if (data.username === oldUsername) {
      data.username = newUsername;
      if (data.chatMetadata && data.chatMetadata.username === oldUsername)
        data.chatMetadata.username = newUsername;
      saveChat(chatId);
    }
}

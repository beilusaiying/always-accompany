/**
 * chatEntryUtils.mjs — 消息条目语义谓词（单一权威）
 *
 * 所有"这条消息算不算活跃/可见/已删"的判断集中在这里。
 * 后续加 _archived 或改语义只改这一个文件，不散到 17 个调用方。
 */

export function isDeleted(entry) {
  return !!entry?.extension?._deleted;
}

export function isHidden(entry) {
  return !!entry?.extension?._hidden;
}

/** 对 AI 不可见（被隐藏 或 被删除） */
export function isActiveEntry(entry) {
  return !isDeleted(entry) && !isHidden(entry);
}

/** 对用户可见（_hidden 灰显仍可见，_deleted 不可见） */
export function isVisibleToUser(entry) {
  return !isDeleted(entry);
}

export function filterActive(chatLog) {
  return (chatLog || []).filter(isActiveEntry);
}

export function filterVisibleToUser(chatLog) {
  return (chatLog || []).filter(isVisibleToUser);
}

export function findLastActive(chatLog) {
  if (!chatLog) return null;
  for (let i = chatLog.length - 1; i >= 0; i--) {
    if (!isDeleted(chatLog[i])) return chatLog[i];
  }
  return null;
}

export function findLastActiveIndex(chatLog) {
  if (!chatLog) return -1;
  for (let i = chatLog.length - 1; i >= 0; i--) {
    if (!isDeleted(chatLog[i])) return i;
  }
  return -1;
}

export function markDeleted(entry, by = "user") {
  if (!entry) return;
  if (!entry.extension) entry.extension = {};
  entry.extension._deleted = true;
  entry.extension._deletedMeta = { by, at: new Date().toISOString() };
}

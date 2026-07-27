/**
 * deleteConfig.mjs — 删除/备份机制数值默认值（单一权威）
 *
 * 所有散装魔法数字集中在这里。调用方 import 这些常量，不写 inline 数字。
 * 用户可配值（从 localStorage/后端配置读）仍然覆盖这些默认值。
 */

export const CHAT_SNAPSHOT_MAX = 5;
export const CHAT_BACKUP_MAX = 20;
export const CHAT_BACKUP_INTERVAL_MS = 10000;
export const FILE_HISTORY_MAX_VERSIONS = 20;
export const MSG_LOAD_LIMIT_DEFAULT = 100;
export const GITHUB_FETCH_TIMEOUT_MS = 15000;

/**
 * constants.mjs — beilu-cli 全局常量（从 YonBan constants.ts 移植，去 TS 类型）
 */

// 文件大小限制（bytes）
export const MAX_READ_FILE_SIZE = 1024 * 1024; // 1MB
export const MAX_EDIT_FILE_SIZE = 2 * 1024 * 1024; // 2MB
export const MAX_DOC_PARSE_SIZE = 20 * 1024 * 1024; // 20MB
export const MAX_SEARCH_FILE_SIZE = 512 * 1024; // 512KB

// 输出截断
export const STDOUT_TRUNCATE_THRESHOLD = 5000;
export const STDOUT_HEAD_KEEP = 3500;
export const STDOUT_TAIL_KEEP = 1000;
export const STDERR_TRUNCATE_THRESHOLD = 5000;
export const STDERR_HEAD_KEEP = 3000;

// 命令执行超时（ms）
export const COMMAND_DEFAULT_TIMEOUT_MS = 120_000;
export const TASKKILL_TIMEOUT_MS = 5_000;
export const RIPGREP_TIMEOUT_MS = 10_000;
export const AST_GREP_TIMEOUT_MS = 15_000;
export const SYNTAX_CHECK_TIMEOUT_MS = 10_000;
export const ESLINT_TIMEOUT_MS = 15_000;

// 容量/数量限制
export const IDE_OP_LOG_MAX = 500;
export const LIST_FILES_MAX = 500;
export const DIAGNOSTICS_MAX = 200;
export const SEARCH_MAX_DEPTH = 8;
export const REFERENCES_MAX = 100;
export const AST_MATCH_MAX = 50;
export const LINT_MSG_MAX = 30;
export const ESLINT_MSG_MAX = 20;

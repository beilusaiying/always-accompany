/**
 * constants.ts — YonBan 全局常量（单一定义点）
 * 新增/修改常量只改这里，其他文件 import 使用。
 */

// ═══════════════════════════════════════════════════════════════
// 网络超时（ms）
// ═══════════════════════════════════════════════════════════════
/** 普通 API 调用超时（ChatService._callApi / getCharacterList / fetchWithAuth 默认） */
export const API_TIMEOUT_MS = 15_000;

/** 插件 API 调用超时（_callPluginApi / getApiSourceList / getApiSourceConfig / switchApiSource） */
export const PLUGIN_API_TIMEOUT_MS = 10_000;

/** Provider 层轻量 fetch 超时（openMemoryFolder / getRuntimeParams / switchPreset 等） */
export const PROVIDER_TIMEOUT_MS = 5_000;

/** 登录请求超时 */
export const LOGIN_TIMEOUT_MS = 10_000;

/** 批量操作超时（deleteMessageRange 等大批量操作） */
export const BULK_OP_TIMEOUT_MS = 30_000;

/** Ping 请求超时（connect() 交互路径：用户点连接要快反馈） */
export const PING_TIMEOUT_MS = 5_000;

/** 心跳 ping 超时（后台活性探测：后端生成大回复时事件循环可阻塞数秒，
 *  5s 会把"忙"误判成"死"——与 WS 心跳 75s 容忍哲学对齐，放宽到 15s） */
export const HEARTBEAT_PING_TIMEOUT_MS = 15_000;

/** Logout 请求超时 */
export const LOGOUT_TIMEOUT_MS = 5_000;

// ═══════════════════════════════════════════════════════════════
// 心跳与重连
// ═══════════════════════════════════════════════════════════════
/** WS / HTTP 心跳间隔 */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/** WS 心跳超时判定（无 pong 即判僵连接，2.5× 间隔容忍单次丢包） */
export const HEARTBEAT_TIMEOUT_MS = 75_000;

/** WS 断线重连延迟（ChatService 主聊天通道） */
export const WS_RECONNECT_DELAY_MS = 3_000;

/** HTTP 心跳丢失后重连初始延迟（ConnectionService，指数退避起点） */
export const HTTP_RECONNECT_DELAY_MS = 5_000;

/** HTTP 重连最大延迟（指数退避上限） */
export const HTTP_MAX_RECONNECT_DELAY_MS = 60_000;

/** HTTP 心跳连续失败容忍次数（允许瞬时网络波动，超过才判断连接）。
 *  0720 抖动敏感修：2→3（判死窗口 ≈3×30s+15s，对齐 WS 2.5× 间隔容忍哲学；
 *  且判死前咨询 WS 活性——WS 活着不判死，见 ConnectionService.setAuxLiveness） */
export const HEARTBEAT_MISS_TOLERANCE = 3;

/** /ws/notify 通道断线重连延迟 */
export const NOTIFY_RECONNECT_DELAY_MS = 5_000;

// ═══════════════════════════════════════════════════════════════
// 文件大小限制（bytes）
// ═══════════════════════════════════════════════════════════════
/** readFile 文本读取大小上限 */
export const MAX_READ_FILE_SIZE = 1024 * 1024; // 1MB

/** 编辑工具（replaceLines/insertAtLine/fuzzyEdit/_anchorInsert）大小上限 */
export const MAX_EDIT_FILE_SIZE = 2 * 1024 * 1024; // 2MB

/** 文档解析（xlsx/docx/pdf 等）大小上限 */
export const MAX_DOC_PARSE_SIZE = 20 * 1024 * 1024; // 20MB

/** Node.js 回退搜索时跳过大文件 */
export const MAX_SEARCH_FILE_SIZE = 512 * 1024; // 512KB

// ═══════════════════════════════════════════════════════════════
// 输出截断
// ═══════════════════════════════════════════════════════════════
/** stdout 截断阈值（超过则保留头尾） */
export const STDOUT_TRUNCATE_THRESHOLD = 5000;

/** stdout 截断保留头部字符数 */
export const STDOUT_HEAD_KEEP = 3500;

/** stdout 截断保留尾部字符数 */
export const STDOUT_TAIL_KEEP = 1000;

/** stderr 截断阈值 */
export const STDERR_TRUNCATE_THRESHOLD = 5000;

/** stderr 截断保留头部字符数 */
export const STDERR_HEAD_KEEP = 3000;

// ═══════════════════════════════════════════════════════════════
// 命令执行超时
// ═══════════════════════════════════════════════════════════════
/** run_command 默认超时 */
export const COMMAND_DEFAULT_TIMEOUT_MS = 120_000;

/** taskkill 子进程杀灭超时 */
export const TASKKILL_TIMEOUT_MS = 5_000;

/** ripgrep 搜索超时 */
export const RIPGREP_TIMEOUT_MS = 10_000;

/** ast-grep 超时 */
export const AST_GREP_TIMEOUT_MS = 15_000;

/** html-validate / node --check 超时 */
export const SYNTAX_CHECK_TIMEOUT_MS = 10_000;

/** eslint 超时 */
export const ESLINT_TIMEOUT_MS = 15_000;

/** LSP 写后诊断等待超时 */
export const LSP_DIAG_TIMEOUT_MS = 1_500;

/** 语言服务器就绪等待超时 */
export const LANG_SERVER_WAIT_MS = 2_000;

/** 语言服务器轮询间隔 */
export const LANG_SERVER_POLL_MS = 200;

/** lintCode 打开文档后等待 LSP 分析的短暂沉降（非就绪轮询，见 vscode-tools lintCode） */
export const LSP_WRITE_SETTLE_MS = 500;

// ═══════════════════════════════════════════════════════════════
// 事件广播防抖（extension.ts 诊断/文件变更 → WS 广播给后端 AI）
// ═══════════════════════════════════════════════════════════════
/** 诊断变化广播防抖 */
export const DIAG_DEBOUNCE_MS = 500;

/** 每个 URI 最多广播的错误条数 */
export const DIAG_ERRORS_PER_FILE = 10;

/** 文件变更广播防抖 */
export const FILE_CHANGE_DEBOUNCE_MS = 2_000;

// ═══════════════════════════════════════════════════════════════
// 控制台捕获 / 错误中心
// ═══════════════════════════════════════════════════════════════
/** ConsoleCapture 内存缓冲上限 */
export const CONSOLE_BUFFER_MAX = 200;

/** 新 WS 客户端连接时回放的历史日志条数 */
export const CONSOLE_REPLAY_COUNT = 50;

/** webview 错误中心环形缓冲上限（与 beilu 主前端 backendMonitor _errors 同值） */
export const ERROR_CENTER_MAX = 50;

// ═══════════════════════════════════════════════════════════════
// webview 轮询间隔（webview 无法 import 本文件——经 YonBanProvider getHtmlContent
// 的 <body data-poll-cfg> JSON 注入下发（T003 data 属性范式），chat-core.js 解析为
// YB.POLL 供各模块消费；webview 侧字面量仅属性缺失时的等值退化）
// ═══════════════════════════════════════════════════════════════
/** Token 进度条轮询间隔 */
export const TOKEN_POLL_MS = 30_000;

/** 记忆 AI 输出状态轮询间隔 */
export const MEMORY_POLL_MS = 15_000;

/** IDE 审批轮询间隔（AI 生成结束后启动，无待审批自动停） */
export const APPROVAL_POLL_MS = 3_000;

/** 并行组运行态兜底轮询间隔（主路径=WS 推送） */
export const GROUP_POLL_MS = 60_000;

// ═══════════════════════════════════════════════════════════════
// 容量/数量限制
// ═══════════════════════════════════════════════════════════════
/** 操作日志最大条数 */
export const IDE_OP_LOG_MAX = 500;

/** 列出文件最大条数 */
export const LIST_FILES_MAX = 500;

/** getDiagnostics / gitLog 结果上限 */
export const DIAGNOSTICS_MAX = 200;

/** searchByName 最大深度 */
export const SEARCH_MAX_DEPTH = 8;

/** findReferences 结果上限 */
export const REFERENCES_MAX = 100;

/** ast-grep 匹配结果上限 */
export const AST_MATCH_MAX = 50;

/** lintCode 消息上限 */
export const LINT_MSG_MAX = 30;

/** eslint 消息上限 */
export const ESLINT_MSG_MAX = 20;

// ═══════════════════════════════════════════════════════════════
// 端口默认值（仅代码内 fallback，主权威在 package.json contributes.configuration）
// ═══════════════════════════════════════════════════════════════
export const DEFAULT_WS_PORT = 8931;
export const DEFAULT_SANDBOX_WS_PORT = 18931;
// T004 收口：本体 HTTP 端口默认值（与 package.json contributes.configuration 的 default 对齐；
// 改端口时两处同改——json schema 无法 import 常量，只能人工对齐）
export const DEFAULT_SERVER_PORT = 1314;
export const DEFAULT_SANDBOX_SERVER_PORT = 13140;
export const DEFAULT_SERVER_URL = `http://localhost:${DEFAULT_SERVER_PORT}`;
export const DEFAULT_SANDBOX_SERVER_URL = `http://localhost:${DEFAULT_SANDBOX_SERVER_PORT}`;

// ═══════════════════════════════════════════════════════════════
// 默认模式（T003 单源：YonBan 是 IDE 插件，主场景=code。旧码三处各写字面量，
// 异常回退曾写 "chat" 导致 IDE 静默漂移成闲聊人格。webview 侧无法 import 本文件，
// 对应单点=webview-ui/chat-core.js YB.DEFAULT_MODE，两点同改）
// ═══════════════════════════════════════════════════════════════
export const DEFAULT_MODE = "code";

/**
 * YonBan 全局类型定义 — 贯穿 services / providers / webview 三层的共享契约。
 * 不管业务逻辑（那是 services 和 providers 的事）。
 *
 * 链路：本模块被所有 services（AuthService / ChatService / ConnectionService / IdeWsServer）
 *       和 YonBanProvider import 使用
 * 影响：纯类型，零运行时副作用
 * 相交：← 几乎所有 .ts 文件引用  → 无（叶节点）
 *
 * 分区索引：
 *   Phase 1A — HTTP 连接层（ConnectionStatus / ConnectionState / ServerInfo / WebviewMessage）
 *   Phase 1B — WS IDE 通道（WsMessageType / WsMessage / ToolCallRequest / ToolCallResult / ConsoleEntry / IdeStatusPayload）
 *   Phase 2A — 聊天服务（ChatSummary / ChatLogEntry / StreamSlice / ChatInitialData / ChatWsEvent）
 *   Phase 2B+ — 角色（CharacterInfo / CharacterDetails）
 *   Phase 3D — 预设管理（PresetConfigData / PresetInfo）
 */

// =====================================================
// Phase 1A: HTTP 连接层类型
// =====================================================

/** 后端连接状态 */
export type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

/** 后端服务器信息（来自 /api/ping） */
export interface ServerInfo {
  version?: string;
  uptime?: number;
  [key: string]: unknown;
}

/** 连接状态变更事件 */
export interface ConnectionState {
  status: ConnectionStatus;
  serverUrl: string;
  serverInfo?: ServerInfo;
  error?: string;
  /** 已登录的用户名 */
  username?: string;
  /** 是否已通过认证（单一权威：AuthService.isAuthenticated） */
  authenticated?: boolean;
}

/** Webview ↔ Extension 通信消息 */
export interface WebviewMessage {
  type: string;
  payload?: unknown;
}

// =====================================================
// Phase 1B: WebSocket IDE 通道类型
// =====================================================

/** WS 协议消息类型 */
export type WsMessageType =
  | "hello" // 服务端→客户端：握手确认
  | "tool_call" // 客户端→服务端：请求执行工具
  | "tool_started" // 服务端→客户端：合法工具调用已接收并开始执行
  | "tool_progress" // 服务端→客户端：工具执行中的进程/输出活动快照
  | "tool_result" // 服务端→客户端：工具执行结果
  | "console" // 服务端→客户端：控制台日志转发
  | "status" // 服务端→客户端：IDE 状态快照
  | "question" // 客户端→服务端：AI提问请求
  | "question_answer" // 服务端→客户端：用户回答
  | "ping" // 心跳请求
  | "pong" // 心跳响应
  | "diagnostics_changed" // 服务端→客户端：编译错误变化通知
  | "file_changed"; // 服务端→客户端：文件被外部修改通知

/** WS 传输的顶层消息结构 */
export interface WsMessage {
  type: WsMessageType;
  /** 消息ID（用于 tool_call / tool_result 配对） */
  id?: string;
  payload: unknown;
}

/** 控制台日志条目 */
export interface ConsoleEntry {
  level: "log" | "warn" | "error" | "info";
  text: string;
  /** HH:MM:SS 格式 */
  time: string;
  /** 来源模块，如 [YonBan] */
  source?: string;
}

/** IDE 状态快照（随 status 消息发送） */
export interface IdeStatusPayload {
  workspaceFolders: string[];
  activeEditor?: string;
  diagnosticCount: number;
  extensionVersion: string;
  wsClients: number;
  uptime: number;
  /** IDE 应用名称（如 "Visual Studio Code"、"Cursor"） */
  appName?: string;
}

/**
 * 工具名称（部分枚举，非穷尽）。
 * 注意：此联合仅列出常用工具，非穷尽——真源=ToolExecutor._handlers 注册表（42 个，含
 * vscode 集成工具、9 个 _checkpoint_ 内部工具、结构化 git 工具）。判断"工具是否存在"以 _handlers 为准，勿仅据本类型。
 */
export type ToolName =
  | "read_file"
  | "write_file"
  | "edit_xlsx"
  | "list_files"
  | "run_command"
  | "run_script"
  | "get_diagnostics"
  | "get_status"
  | "search_files"
  | "search_by_name"
  | "replace_lines"
  | "insert_at_line"
  | "fuzzy_edit"
  | "todo_read"
  | "todo_write";

/** 工具调用请求体（嵌在 WsMessage.payload 中） */
export interface ToolTransportMeta {
  /** 本体用户可编辑的读取/搜索运行策略；与公开 params 平级，第三方工具不可见。 */
  runtimePolicy?: Record<string, unknown>;
  /** 已认证 owner，仅用于执行端内部隔离；不得写入公开工具参数或操作日志。 */
  ownerUsername?: string | null;
}

export interface ToolCallRequest {
  id: string;
  tool: ToolName;
  params: Record<string, unknown>;
  /** 三层关联 ID（本体生成，贯穿 本体→YonBan→前端 日志），供单次操作端到端拼接 */
  traceId?: string;
  /** [窗口id 0726] 指令所属窗口/线 id（=chatid，后端 ideClient 传导层单点注入）。
   *  执行器仅在需要会话池的内建 handler 边界派生内部窗口键，不污染公开 params。
   *  旧后端不发此字段（可选）——缺失时回落无 id 语义。 */
  chatid?: string | null;
  /** 传输私有元数据。旧 producer 缺失时执行端采用安全默认值。 */
  transport?: ToolTransportMeta;
  /** 执行端 WS server 覆盖写入的连接身份；不信任 producer 自报值。 */
  connectionId?: string;
}

/** 工具调用已接收（嵌在 WsMessage.payload 中） */
export interface ToolStartedPayload {
  id: string;
  tool: ToolName;
  chatid: string | null;
  startedAt: string;
}

/** 工具执行中进度（嵌在 WsMessage.payload 中） */
export interface ToolProgressPayload {
  id: string;
  tool: ToolName;
  chatid: string | null;
  progress: Record<string, unknown>;
  occurredAt: string;
}

/** 工具调用结果体（嵌在 WsMessage.payload 中） */
export interface ToolCallResult {
  id: string;
  success: boolean;
  result?: unknown;
  error?: string;
  /** 执行耗时 ms */
  duration?: number;
  /** 系统诊断信息（帮助AI判断是参数问题还是系统问题） */
  _debug?: Record<string, unknown>;
  /** 权威解析路径：YonBan resolveWorkspacePath(path) 的结果，供后端 fs 操作对齐真实工作区路径（闭合跨进程路径盲区） */
  resolvedPath?: string;
}

// =====================================================
// Phase 2A: 聊天服务类型
// =====================================================

/** 聊天列表摘要（来自 GET /getchatlist） */
export interface ChatSummary {
  chatid: string;
  /** 聊天中的角色名列表（后端字段名为 chars） */
  chars?: string[];
  /** 主角色名 */
  primaryCharName?: string;
  /** 最后一条消息的发送者 */
  lastMessageSender?: string;
  /** 最后一条消息内容片段 */
  lastMessageContent?: string;
  /** 最后一条消息时间 */
  lastMessageTime?: string;
  lastModified?: number;
  /** 用户第一条消息前60字符 */
  firstUserMessage?: string;
  /** 用户自定义名称 */
  customName?: string;
  [key: string]: unknown;
}

/** 聊天消息条目 */
export interface ChatLogEntry {
  id: string;
  role: "user" | "char" | "system";
  name?: string;
  /** AI 原始输出（含标签） */
  content: string;
  /** 清理后展示文本 */
  content_for_show?: string;
  /** 编辑时显示（预留） */
  content_for_edit?: string;
  avatar?: string;
  time_stamp?: string;
  /** true = AI 正在生成中的占位消息 */
  is_generating?: boolean;
  extension?: Record<string, unknown>;
}

/** 流式更新切片 */
export type StreamSlice =
  | { type: "append"; add: { content: string } }
  | { type: "rewrite_tail"; index: number; content: string }
  | { type: "set_files"; files: unknown[] };

/** 初始数据（GET /{chatid}/initial-data 返回） */
export interface ChatInitialData {
  chatLog: ChatLogEntry[];
  chars: string[];
  plugins: string[];
  [key: string]: unknown;
}

/** 聊天 WS 广播事件 */
export interface ChatWsEvent {
  type: string;
  payload: unknown;
}

// =====================================================
// Phase 2B+: 角色相关类型
// =====================================================

/** 角色基本信息（来自 GET /api/parts/details/chars/{name}） */
export interface CharacterInfo {
  name?: string;
  avatar?: string;
  description?: string;
  [key: string]: unknown;
}

/** 角色详情包装（后端返回格式） */
export interface CharacterDetails {
  info: CharacterInfo;
  [key: string]: unknown;
}

// =====================================================
// Phase 3D: 预设管理类型
// =====================================================

/** 预设配置数据（来自 GET beilu-preset/config/getdata） */
export interface PresetConfigData {
  active_preset: string;
  presets: Record<
    string,
    {
      preset_json?: unknown;
      mode?: string;
      mode_triggers?: string[];
      description?: string;
    }
  >;
  [key: string]: unknown;
}

/** 预设摘要（前端展示用） */
export interface PresetInfo {
  name: string;
  isActive: boolean;
  mode?: string;
  description?: string;
}

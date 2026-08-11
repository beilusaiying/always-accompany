/**
 * volatileMacros.mjs — 高动态提示词宏清单单一真源（0731 缓存归零调查后新增）
 *
 * 【为什么存在】0729「工具系统_宏状态_INJ反馈专项」把 {{tool_runtime_json}} 写进了 depth>=1
 *   （历史上方）手册条目正文：宏每轮展开出不同值（工具 job 总账，实测 115k 字符/轮），坐在
 *   Anthropic 累积前缀哈希的缓存前缀区 → 每轮从该处失配，全部 messages 层缓存连坐 → 命中≈0、
 *   每轮 ~20 万 token 当量按 2x 重写（调查报告：proxy缓存效率调查_20260731_0154）。0722 已在
 *   preset/main.mjs 分派点注释确诊过同款失效模式，但 INJ 数据侧无任何机制拦截，靠人眼审文本
 *   必然复发（凛倾 0731：条目里只见 {{user}} 之类简单宏的印象骗过了人）。
 *
 * 【职能】定义历史前缓存区的宏契约。包括每轮变化、连接/配置变化、当前身份/项目
 *   变化和插件运行数据；只要宏值能在 INJ 正文不变时改变，就必须住 depth:0。消费方：
 *   - getDataHandler.mjs → getData 响应 volatile_macros 字段（后端权威清单下发范式，
 *     同 injection_automode_meta / web_search_engines / param_schema）
 *   - 前端 INJ 编辑器 panels.mjs _loadInjPanel → depth>=1 且启用的条目正文含清单宏时
 *     弹窗警告 + 列表徽标 + 详情页标出宏所在行
 *   - setDataActions.mjs → 新增/修改/导入时检测，warning 随成功返回下发（凛倾 0810 定案：
 *     只提醒不拦截，保存一律按用户配置执行）
 *   - getPromptHandler.mjs → 运行时检测并记录 extension.cache_safety_adjustments + 白盒诊断
 *     （凛倾 0810 定案：不再强制改写 depth/role，注入按用户配置原样执行；effectiveDepth/
 *     effectiveRole 字段保留为"缓存安全建议值"供提醒面展示，不再被执行层消费）
 *
 * 【收录判据】宏值若可能随会话、轮次、时间、连接、项目、用户配置、插件状态或当前身份变化
 *   就收录。历史前只允许真正静态的 schema/确定性格式宏、{{ide_tools}}，以及按请求身份分区的
 *   {{user}}/{{char}}。运行时安全判断采用稳定宏 allowlist，而不是可能漏项的动态宏 denylist；
 *   增删稳定宏必须在本模块登记，前端禁止镜像硬编码。
 *
 * 【依赖纪律】保持零 import 纯叶子（同 entryKind.mjs 范式），getDataHandler 与 getPromptHandler
 *   均可安全引用，不引入环。!!!禁止放入提示词!!! 本模块只做识别，不产生任何进 messages 的文本。
 */

/**
 * 允许住在历史前缓存区的宏（不含花括号）。
 * - ide_tools：模块加载期从工具注册表生成的字节静态 schema。
 * - user/char：按请求身份/角色卡分区；不是跨身份共享的全局缓存键。
 * 另有 CACHE_STABLE_PREFIX_MACRO_PATTERNS 收录只由模板字节决定的确定性语法。
 * 其余任何 {{...}} 表达式默认不安全；这样新增 producer 时无需等待 denylist 同步才受保护。
 */
export const CACHE_STABLE_PREFIX_MACROS = Object.freeze([
  "ide_tools", "user", "char",
  // marco.mjs 中不读取时间/会话/变量且结果只由模板字节决定的空操作/格式宏。
  "newline", "trim", "noop",
]);

/** 可确定性求值的带参数宏表达式；字符串形式同步下发前端，避免镜像硬编码。 */
export const CACHE_STABLE_PREFIX_MACRO_PATTERNS = Object.freeze([
  String.raw`^//[\s\S]*$`,
  String.raw`^reverse::[\s\S]*$`,
  String.raw`^banned\s+"[^"]*"$`,
  String.raw`^pick\s?::?[\s\S]*$`,
]);

// 提取最短的 {{...}} 候选，同时允许参数中出现单花括号/JSON。旧 [^{}]+ 会把
// {{random::a,{b}}}、{{setvar::x::{value}}}、未来 JSON 参数宏整体漏掉，形成写闸与运行时旁路。
// 这是后端与 INJ 编辑器共享的语法源；稳定性判定会把候选中残留的任何花括号保守判为 unsafe。
export const CACHE_PROMPT_MACRO_EXPRESSION_PATTERN = String.raw`\{\{\s*([\s\S]*?)\}\}`;

const _CACHE_STABLE_PREFIX_MACRO_SET = new Set(CACHE_STABLE_PREFIX_MACROS);
const _CACHE_STABLE_PREFIX_MACRO_REGEXES = CACHE_STABLE_PREFIX_MACRO_PATTERNS.map((source) => new RegExp(source, "i"));

export function isCacheStablePrefixMacroExpression(expression) {
  const normalized = String(expression || "").trim();
  if (!normalized) return true;
  // 非贪婪提取遇到内层/单花括号时可能在最早的 }} 截止；无论它是嵌套动态宏、JSON 参数
  // 还是未来语法，都不能套用 pick/comment 等宽松稳定 pattern，必须保守落到历史后。
  if (/[{}]/.test(normalized)) return false;
  if (_CACHE_STABLE_PREFIX_MACRO_SET.has(normalized.toLowerCase())) return true;
  return _CACHE_STABLE_PREFIX_MACRO_REGEXES.some((pattern) => pattern.test(normalized));
}

/** 返回正文里的宏表达式（去掉花括号，去重，保持出现顺序）。 */
export function listPromptMacroExpressions(content) {
  const found = [];
  const seen = new Set();
  const expressionPattern = new RegExp(CACHE_PROMPT_MACRO_EXPRESSION_PATTERN, "g");
  for (const match of String(content || "").matchAll(expressionPattern)) {
    const expression = String(match[1] || "").trim();
    const key = expression.toLowerCase();
    if (!expression || seen.has(key)) continue;
    seen.add(key);
    found.push(expression);
  }
  return found;
}

/**
 * 返回不允许位于历史前缓存区的宏表达式。
 * 使用 allowlist 是刻意的：可识别 code_file:*、插件 macro_env、未来新增宏和直接改盘旁路。
 */
export function findUnsafeCachePrefixMacros(content) {
  return listPromptMacroExpressions(content).filter(
    (expression) => !isCacheStablePrefixMacroExpression(expression),
  );
}

/** 对一条 INJ 计算请求位置、缓存安全有效位置与命中表达式。 */
export function inspectInjectionCachePrefix(entry) {
  const requestedDepth = Number(entry?.depth) || 0;
  const requestedRole = String(entry?.role || "system");
  const dynamicMacros = entry?.enabled !== false
    ? findUnsafeCachePrefixMacros(entry?.content)
    : [];
  const effectiveDepth = dynamicMacros.length > 0 && requestedDepth >= 1 ? 0 : requestedDepth;
  // Anthropic-compatible adapters extract every system role into the top-level system block, even if
  // commander placed it after history. Dynamic depth:0 data must therefore use user role to preserve
  // its true request order and keep it outside the stable system/history prefix.
  const effectiveRole = dynamicMacros.length > 0 && effectiveDepth === 0 ? "user" : requestedRole;
  return Object.freeze({
    safe: effectiveDepth === requestedDepth && effectiveRole === requestedRole,
    requestedDepth,
    effectiveDepth,
    requestedRole,
    effectiveRole,
    unsafeMacros: Object.freeze(dynamicMacros),
  });
}

/** 每轮/高频变化的已知宏名（兼容旧客户端展示；运行时安全不依赖这份 denylist）。 */
export const VOLATILE_PROMPT_MACROS = Object.freeze([
  "tableData", // 当前表格内容
  "hotMemory", // 当前热记忆内容
  "current_date", // 当前日期（另一命名）
  "contextSummary", // 当前会话压缩摘要
  "env_info", // 当前项目环境摘要
  "memory_path", // 当前用户/角色记忆路径
  "workspace_root", // 预设引擎二次展开的当前工作区根
  "workspace_tree", // 预设引擎二次展开的当前工作区树
  "code_file:*", // 动态文件引用宏族；新 UI/运行时按通用表达式扫描
  "tool_runtime_json", // 工具 job 运行态快照（0731 事故主角；forPrompt 单次投递）
  "mcp_runtime_json", // MCP 连接/发现/工具数运行态
  "env_tools", // 用户配置+项目 package/依赖扫描结果
  "client_env", // 当前客户端/连接环境
  "chat_history", // 全量聊天记录展开
  "ide_read_cache", // 已读文件缓存清单（每次 read 变）
  "ide_workspace", // 工作区状态
  "token_status", // 上下文 token 状态（每轮变）
  "current_mode", // 当前顶层模式
  "sub_mode", // 当前子模式
  "sub_mode_desc", // 当前子模式说明
  "clone_runtime", // 分身运行态
  "clone_configs", // 当前启用分身配置
  "scheduler_jobs_summary", // 调度器任务摘要
  "scheduler_due", // 到期任务
  "work_tasks", // 工作任务清单
  "work_tables_data", // 工作表格数据
  "code_active_files", // 活动文件内容（编辑即变）
  "code_files_list", // active 目录清单
  "active_project", // 当前项目
  "work_sub_modes_list", // 工作子模式实时注册表
  "code_sub_modes_list", // code 子模式实时注册表
  "sub_modes_all", // 全模式实时注册表
  "idle_duration", // 距上条消息时长（分钟级）
  "time", // 当前时刻（分钟级）
  "currentTime", // 插件系统当前时间
  "date", // 当前日期
  "weekday", // 当前星期
  "lasttime", // 上条消息时刻
  "lastdate", // 上条消息日期
  "lastUserMessage", // 最后一条用户消息
  "sub_mode_tool_permissions_json", // 当前子模式硬权限镜像（[0804] 原 sub_mode_contract_json 随 contract 字段全链删除改名；切换身份/配置即变，只能放 depth:0）
  "approval_results",
  "async_ai_results",
  "p1_act",
  "p1_retrieval_ts",
  "p1_retrieval",
  "chat_search_ts",
  "chat_search_results",
  "table_edit_ts",
  "table_edit_failures",
  "parallel_count",
  "parallel_results",
  "flow_group_name",
  "flow_group_progress",
  "flow_group_steps",
  "flow_group_current",
  "flow_group_auto_advance",
  "p8_results",
  "browser_status",
  "browser_port",
  "clone_tables",
  "clone_context_count",
  "clone_context",
  "delegate_seq",
  "delegate_from",
  "delegate_priority",
  "delegate_source_channel",
  "delegate_user_message",
  "delegate_task",
  "delegate_chat_context",
  "delegate_report_instruction",
  "delegate_report_to",
  "delegate_report_status",
  "delegate_report_task",
  "delegate_report_body",
  "ppt_usage", // 插件配置+输出根目录拼出的长说明块，禁止放历史前
  "ppt_out_root",
  "ppt_last_deck",
]);

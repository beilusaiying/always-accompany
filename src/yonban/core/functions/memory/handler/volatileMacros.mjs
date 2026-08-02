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
 * 【职能】枚举"每轮（或分钟级）产生不同展开值"的宏。消费方：
 *   - getDataHandler.mjs → getData 响应 volatile_macros 字段（后端权威清单下发范式，
 *     同 injection_automode_meta / web_search_engines / param_schema）
 *   - 前端 INJ 编辑器 panels.mjs _loadInjPanel → depth>=1 且启用的条目正文含清单宏时
 *     弹窗警告 + 列表徽标 + 详情页标出宏所在行
 *
 * 【收录判据】展开函数读运行态/会话数据/时间（正常工作中逐轮变化）= 收录；
 *   只随配置或连接事件变化（{{user}}/{{char}}/{{mcp_runtime_json}}/{{env_tools}}/{{client_env}}）
 *   或按天变化（{{date}}/{{weekday}}）= 不收录（凛倾 0731："特别固定不会一直动的比如 mcp、user
 *   不用挪"）。增删宏或改动展开实现的易变性时同步本表——判据只此一处，前端禁止镜像硬编码。
 *
 * 【依赖纪律】保持零 import 纯叶子（同 entryKind.mjs 范式），getDataHandler 与 getPromptHandler
 *   均可安全引用，不引入环。!!!禁止放入提示词!!! 本模块只做识别，不产生任何进 messages 的文本。
 */

/** 每轮/高频变化的宏名（不含花括号）。展开点见 getPromptHandler.mjs 替换链。 */
export const VOLATILE_PROMPT_MACROS = Object.freeze([
  "tool_runtime_json", // 工具 job 运行态快照（0731 事故主角；forPrompt 单次投递）
  "chat_history", // 全量聊天记录展开
  "ide_read_cache", // 已读文件缓存清单（每次 read 变）
  "ide_workspace", // 工作区状态
  "token_status", // 上下文 token 状态（每轮变）
  "clone_runtime", // 分身运行态
  "scheduler_jobs_summary", // 调度器任务摘要
  "work_tasks", // 工作任务清单
  "work_tables_data", // 工作表格数据
  "code_active_files", // 活动文件内容（编辑即变）
  "code_files_list", // active 目录清单
  "idle_duration", // 距上条消息时长（分钟级）
  "time", // 当前时刻（分钟级）
  "lasttime", // 上条消息时刻
  "lastUserMessage", // 最后一条用户消息
]);

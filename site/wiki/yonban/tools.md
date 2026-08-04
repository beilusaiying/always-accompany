# 工具列表

YonBan 提供 30+ 工具，AI 在对话中通过 `<ideToolCall>` 标签调用。写操作需经审批系统批准后才执行。

## 文件操作（7）

| 工具 | 功能 | 关键参数 | 读/写 |
|------|------|---------|-------|
| read_file | 读取文件内容（支持分页与 xlsx/docx/pptx/pdf 文档解析） | path, offset, limit | 读 |
| write_file | 写入/创建文件 | path, content | 写 |
| list_files | 列出目录内容 | path, recursive | 读 |
| replace_lines | 按行号范围替换内容 | path, start_line, end_line, new_content | 写 |
| insert_at_line | 在指定行号插入内容 | path, line, content | 写 |
| fuzzy_edit | 模糊匹配替换（容忍缩进/空行差异） | path, old_string, new_string | 写 |
| edit_xlsx | 读写 Excel 文件 | path, sheet, operations | 写 |

## 搜索（4）

| 工具 | 功能 | 关键参数 | 读/写 |
|------|------|---------|-------|
| search_files | 正则/文本搜索文件内容 | pattern, path, regex | 读 |
| search_by_name | 按文件名模式搜索 | pattern, path | 读 |
| smart_search | 语义搜索（结合文件名 + 内容 + 路径） | query, path | 读 |
| ast_search | AST 结构搜索（函数/类/变量定义） | pattern, language | 读 |

## 命令执行（2）

| 工具 | 功能 | 关键参数 | 读/写 |
|------|------|---------|-------|
| run_command | 在 IDE 终端执行命令 | command, cwd | 写 |
| run_script | 执行脚本文件 | path, args | 写 |

**进程静默看门狗（Command Stall Watchdog）**：run_command / run_script 执行期间，系统监控进程的 CPU、内存与输出静默时长——命令长时间无输出且无活动时（默认静默 60 秒判定、5 秒采样），自动终止整棵进程树并返回结构化的 `[tool_failure]`（附已产生的 stdout/stderr），AI 能据此判断和汇报，而不是黑屏干等。看门狗策略（终止/仅通知）与停滞通知开关在设置面板可编辑。**失败语义也更诚实**：非零退出码、输出超限（1MB）现在会如实报失败——不会再"看起来成功"。

## 诊断（5）

| 工具 | 功能 | 关键参数 | 读/写 |
|------|------|---------|-------|
| get_diagnostics | 获取 IDE 诊断信息（错误/警告） | path | 读 |
| get_status | 获取 IDE 状态（打开文件/活动编辑器） | — | 读 |
| get_project_summary | 获取项目结构摘要 | path | 读 |
| validate_html | 校验 HTML 文件 | path | 读 |
| lint_code | 代码 lint 检查 | path, rules | 读 |

## 导航（2）

| 工具 | 功能 | 关键参数 | 读/写 |
|------|------|---------|-------|
| goto_definition | 跳转到符号定义 | path, line, character | 读 |
| find_references | 查找符号的所有引用 | path, line, character | 读 |

## TODO（2）

| 工具 | 功能 | 关键参数 | 读/写 |
|------|------|---------|-------|
| todo_read | 读取 TODO 列表 | filter | 读 |
| todo_write | 写入/更新 TODO 项 | items | 写 |

## Git（9）

| 工具 | 功能 | 关键参数 | 读/写 |
|------|------|---------|-------|
| git_status | 查看工作区状态 | cwd | 读 |
| git_diff | 查看变更差异 | staged, path, cwd | 读 |
| git_log | 查看提交历史 | maxCount, cwd | 读 |
| git_add | 暂存文件 | paths, path, cwd | 写 |
| git_commit | 提交 | message, all, cwd | 写 |
| git_branch | 创建/列出分支 | create, cwd | 写 |
| git_checkout | 切换分支 | branch, cwd | 写 |
| git_stash | 暂存工作区 | action, message, ref, cwd | 写 |
| git_merge | 合并分支 | branch, noFf, cwd | 写 |

git 全家族接受可选 `cwd`（仓库目录，工作区内路径）：仓库在工作区子目录时指定，缺省在工作区根执行。

## 内部工具

以 `_` 前缀命名的工具供系统内部使用，不由 AI 直接调用：

| 工具 | 功能 |
|------|------|
| _checkpoint_start | 开启一次快照事务 |
| _checkpoint_commit | 提交快照事务 |
| _checkpoint_revert | 回退到指定快照 |
| _checkpoint_revert_to_message | 回退到某条消息对应的状态 |
| _checkpoint_revert_diff | 按差异回退 |
| _checkpoint_list | 列出所有快照 |
| _checkpoint_can_replay | 查询某快照是否可重放 |
| _checkpoint_get_ops | 获取快照的操作记录 |
| _checkpoint_get_diff | 获取快照差异 |
| _get_operation_log | 读取操作日志 |
| _reveal | 在 IDE 中打开/高亮指定文件 |

快照工具支撑编程模式的操作时间线功能——AI 每次修改文件前自动创建快照，用户可通过时间线面板回退到任意历史节点。

## 导航

- [YonBan 概览](overview.md) — 安装与连接
- [审批与权限](approval.md) — 哪些工具需要审批
- [执行链路](architecture.md) — 工具调用的完整执行流程

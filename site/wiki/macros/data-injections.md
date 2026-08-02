# 数据注入条目与数据宏（*-data）

动态内容（每轮或频繁变化的数据）统一通过**尾部数据注入条目**进入对话——它们是 `injection_prompts` 里 id 以 `-data` 结尾的条目，`depth: 0`（注入在聊天历史下方）。模板文本在 INJ 面板可编辑，代码只负责提供数据宏的值。

## 为什么动态内容必须在尾部

提示词缓存按前缀匹配：头部（system 区）任何一个字符变化，整个缓存前缀作废，每轮重新计费/重新处理几万 token。因此：

- **固定内容**（身份、规则、能力说明）→ 头部（`depth >= 1`），稳定不变，可被缓存
- **动态内容**（状态、检索结果、任务数据、每轮变化的宏）→ 尾部（`depth: 0` 的 `*-data` 条目），在缓存断点之后，变化不破坏缓存
- 缓存断点由代理层自动放在 `*-data` 条目之前（`-data` 后缀是易变区检测的识别标记之一）

## 铁律与拦截机制

**提示词文本只允许存在于 INJ 条目和预设中，代码里禁止硬编码提示词。** 唯一豁免：AI 发出指令后的系统回执（工具执行结果等），它们天然出现在对话尾部。

机制强制（不靠自觉）：

- `getPromptHandler` 返回前做**白名单校验**：注入条目的 id 必须在 `injection_prompts` 注册，未注册的注入直接拦截删除，并在诊断系统留下可见告警（`dataInj:hardcodeBlocked`）
- 新增注入必须先在配置注册条目（模板前端可改），代码经统一入口 `_pushDataInj` 只提供数据宏值
- 条目缺失（副本未播种/被删）会产生可见告警 `dataInj:entryMissing`，前端「恢复默认」可找回

## 数据注入条目清单

以下条目由数据生产点按需注入（无数据时整条不注入）；模板中的宏为**条目局部数据宏**，仅在对应条目模板内有效：

| 条目 id | 内容 | 数据宏 | 触发条件 |
|---------|------|--------|----------|
| `INJ-p1-act-data` | P1 自驱动方向词 | `{{p1_act}}` | P1 管线有产出 |
| `INJ-p1-retrieval-data` | 记忆AI检索结果 | `{{p1_retrieval}}` `{{p1_retrieval_ts}}` | P1 检索有结果 |
| `INJ-p8-web-search-data` | 联网搜索结果 | `{{p8_results}}` | P8 搜索有结果 |
| `INJ-chat-search-data` | 上轮聊天AI搜索结果 | `{{chat_search_results}}` `{{chat_search_ts}}` | 有待注入搜索结果 |
| `INJ-table-edit-feedback-data` | 上轮 tableEdit 失败明细 | `{{table_edit_failures}}` `{{table_edit_ts}}` | 有失败反馈 |
| `INJ-scheduler-due-data` | 到期定时任务提醒 | `{{scheduler_due}}` | 有到期任务 |
| `INJ-delegate-task-data` | 活跃委派任务 | `{{delegate_seq}}` `{{delegate_from}}` `{{delegate_priority}}` `{{delegate_source_channel}}` `{{delegate_user_message}}` `{{delegate_task}}` `{{delegate_chat_context}}` `{{delegate_report_instruction}}` | 有活跃委派 |
| `INJ-delegate-report-data` | 委派完成报告 | `{{delegate_report_to}}` `{{delegate_report_status}}` `{{delegate_report_task}}` `{{delegate_report_body}}` | 有未注入报告 |
| `INJ-parallel-delegate-data` | 并行委派结果 | `{{parallel_count}}` `{{parallel_results}}` | 有并行结果 |
| `INJ-approval-results-data` | 审批结果回喂 | `{{approval_results}}` | 有审批决定 |
| `INJ-async-ai-data` | 后台AI结果 | `{{async_ai_results}}` | 有异步结果 |
| `INJ-flow-group-data` | 流程组执行状态 | `{{flow_group_name}}` `{{flow_group_progress}}` `{{flow_group_steps}}` `{{flow_group_current}}` `{{flow_group_auto_advance}}` | 流程组运行中 |

模板里可选字段的"标签: "行在数据为空时会整行自动剔除（机制行为，模板可放心写全字段）。

## 动态宏归尾条目（从头部拆出）

以下条目承载原本混在头部说明块里的动态宏（全局宏，见各宏文档页）：

| 条目 id | 内容 | 宏 | 原位置 |
|---------|------|-----|--------|
| `INJ-browser-status-data` | 浏览器连接状态行 | `{{browser_status}}` `{{browser_port}}` | 原 INJ-browser（头部）尾行 |
| `INJ-work-submodes-data` | work 组子模式实时清单 | `{{work_sub_modes_list}}` | 原 INJ-1-work（头部） |
| `INJ-code-submodes-data` | code 组子模式实时清单 | `{{code_sub_modes_list}}` | 原 INJ-2-code（头部） |

对应的头部条目改为指向说明（"实时清单见尾部注入块"），保持头部逐轮稳定。

## 编辑与恢复

- 所有 `*-data` 条目在 **INJ 注入面板** 可编辑（content 模板 / depth / order / 开关）
- 改坏了用「恢复默认」找回出厂模板
- 关闭条目（enabled=false）= 对应数据不再注入（数据生产逻辑照常运行，只是不进对话）

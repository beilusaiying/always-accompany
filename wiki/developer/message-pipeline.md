# 消息管线

消息管线是 always-accompany 中从用户发送消息到 AI 回复显示的完整数据流。理解这条链路是理解 always-accompany 运作原理的关键。

## 全链路概览

<div class="wiki-flow">
  <div class="wiki-box wiki-box-amber wiki-box-full"><b>用户在前端发送消息</b></div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-blue wiki-box-full"><b>POST /:chatid/message</b><small>endpoints.mjs</small></div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-blue wiki-box-full"><b>addUserReply</b><small>chatOps.mjs — 保存用户消息到 chatLog</small></div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-green wiki-box-full"><b>triggerCharReply</b><small>generation.mjs — 触发 AI 回复</small></div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-green wiki-box-full"><b>getChatRequest</b><small>requestBuilder.mjs — 构建请求对象</small></div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-green wiki-box-full"><b>buildPromptStruct</b><small>组装提示词结构</small></div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-group" style="width:100%;max-width:480px;">
    <div class="wiki-group-title">插件参与阶段</div>
    <div class="wiki-flow" style="margin:0;">
      <div class="wiki-box wiki-box-purple wiki-box-full"><b>各插件 GetPrompt</b><small>并行收集提示词片段</small></div>
      <div class="wiki-arrow">↓</div>
      <div class="wiki-box wiki-box-purple wiki-box-full"><b>各插件 TweakPrompt × 3 轮</b><small>调整提示词结构</small></div>
    </div>
  </div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-green wiki-box-full"><b>executeGeneration</b><small>generation.mjs</small></div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-green wiki-box-full"><b>GetReply → StructCall</b><small>provider — 调用 AI API</small></div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-green wiki-box-full"><b>AI 流式响应</b><small>StreamManager 逐 chunk 推送</small></div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-purple wiki-box-full"><b>各插件 ReplyHandler</b><small>解析回复中的操作标签</small></div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-blue wiki-box-full"><b>finalizeEntry</b><small>构建消息条目</small></div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-blue wiki-box-full"><b>addChatLogEntry</b><small>chatOps.mjs — 保存 AI 回复到 chatLog</small></div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-red wiki-box-full"><b>broadcastChatEvent</b><small>WS 推送给前端</small></div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-red wiki-box-full"><b>自动续轮决策</b><small>是否继续生成</small></div>
</div>

## 各阶段详解

### 1. 用户发送消息

前端通过 `POST /:chatid/message` 端点发送用户消息。端点经过 `router.param("chatid")` 归属校验后，交给 chatOps 处理。

### 2. 保存用户消息

`addUserReply` 将用户消息构建为 `chatLogEntry_t`，push 到 chatLog 数组，保存到磁盘，并通过 WS 广播 `message_added` 事件通知前端。

### 3. 构建请求对象

`getChatRequest` 负责组装完整的 `chatReplyRequest_t` 对象：

- 加载对话元数据（chatMetadata）
- 解析用户和角色信息
- 合并默认插件（getAllDefaultParts 的插件即使不在旧聊天的 timeSlice 中也会参与）
- 获取可见聊天日志（getVisibleChatLog）

### 4. 组装提示词结构

`buildPromptStruct` 调用管线运行时（yonban pipelines），触发所有 Part 的 GetPrompt 和 TweakPrompt：

#### GetPrompt 阶段

每个插件返回自己要注入到提示词中的文本片段。返回值进入 `prompt_struct` 的对应区域：

- `char_prompt` — 角色相关提示
- `user_prompt` — 用户相关提示
- `world_prompt` — 世界/环境相关提示
- `plugin_prompts` — 插件提示（按插件名分区）

beilu-preset 的 GetPrompt 返回空壳（预设的真正工作在 TweakPrompt 阶段）。

#### TweakPrompt 三轮

所有插件的 TweakPrompt 按 detail_level 递减执行三轮：

| 轮次 | dl 值 | 核心动作 |
|------|-------|---------|
| Round 1 | 2 | 收集清空 — 读取各模块提示词到宏环境 env，清空原始模块 |
| Round 2 | 1 | 重建消息 — 引擎 buildAllEntries() 产出四段消息，合并 model_params |
| Round 3 | 0 | 快照 — 记录调试快照（commanderSnapshot），不再改 chat_log |

### 5. AI API 调用

`executeGeneration` 是流式生成核心。它通过 GetReply 接口调用 provider 的 StructCall：

- **StructCall** 接收 prompt_struct，调用 `assembleCommanderMessages`（司令员模式）或直接拼装消息
- **applyModelParams** 将 canonical 参数映射为 provider 特定形状
- 发起 HTTP/SSE 流式请求，逐 chunk 返回

### 6. 流式响应处理

StreamManager 管理流式响应：

- 逐 chunk 解析 SSE 数据
- 通过 WS 广播 `stream_start` / `stream_update` 事件给前端
- 前端逐字显示 AI 回复

### 7. ReplyHandler 解析

AI 回复完成后，各插件的 ReplyHandler 依次处理：

- **beilu-files**：解析 `<file_op>` / `<tool_call>` 标签，执行文件操作
- **beilu-regex**：执行正则替换规则
- **beilu-mvu**：解析变量操作命令
- **beilu-memory**：**25+ 种标签的统一分派中枢**（详见下节）
- **beilu-web**：解析 `<search>` / `<browse>` 标签，触发联网请求

#### beilu-memory：标签驱动的副作用中枢

beilu-memory 的 ReplyHandler（`memory/handler/replyHandler.mjs` 的 `handleReply`）远不止解析 `<tableEdit>`——它是整个"通用指令系统"的执行体。设计哲学：**AI 用标签而非 JSON 表达意图**。标签自然地混在回复文本里，`handleReply` 按固定处理序逐个解析、执行副作用、落盘并广播，最后在显示清理阶段把内部协议标签从用户可见内容（content_for_show）中剥掉——用户看到的是干净回复，系统拿到的是结构化指令。

按职能分组的标签清单（处理序号见 replyHandler.mjs 头注释）：

| 职能 | 标签 |
|------|------|
| 记忆与表格 | `<tableEdit>` `<memoryArchive>` `<memorySearch>` `<memoryNote>` |
| 任务清单 | `<taskPlan>` `<taskCheck>` |
| 热层写入 | `<codeMemoryWrite>` `<workMemoryWrite>` |
| 联网搜索 | `<needWebSearch>`（executeWebSearch，结果缓存供下轮 GetPrompt 注入） |
| 模式切换 | `<modeSwitch>`（per-chatId）`<subModeSwitch>`（writeActiveSubModeId + 跨组拒绝 + 回路检测） |
| IDE 工具 | `<ideToolCall>`（读写分离 → 安全检查 → 审批门/直接执行） |
| 委派与分身 | `<delegate>` `<parallelDelegate>` `<report>` `<分身N>` |
| 跨窗口/定时 | `<scheduleWakeup>` `<wakeWindow>` `<sendToWindow>`（统一经 dispatchActivation 分发） |
| 审批与进度 | `<approval>` `<progress>` `<needHelp>` |
| 流程与外设 | `<createFlowGroup>` `<captureControl>` `<browserAction>` `<mcpConnect>` |
| 上下文管理 | `<contextClean>`（hideMessages 可逆隐藏 / purge）`<stopContinue>` `<fileDelivery>` |
| 已废弃 | `<presetSwitch>`（主AI侧 2026-07-17 起仅清理不执行，统一改用 `<subModeSwitch>`） |

这也是为什么"给 AI 加一种新能力"在 beilu 里通常意味着"教它一个新标签 + 在 replyHandler 挂一个处理块"，而不是加一个 API 端点。

### 8. 保存与广播

`finalizeEntry` 构建最终的 AI 消息条目（chatLogEntry_t），通过 `addChatLogEntry` 保存到 chatLog 并广播。

### 9. 自动续轮

如果 AI 的回复触发了续轮条件（如正在执行编程任务、工具调用后需要继续），系统自动触发新一轮的 `triggerCharReply`。

续轮有安全限制：
- 续轮无次数上限，可通过面板开关控制
- 空回复重试限制（EMPTY_REPLY_MAX_RETRIES = 3）
- fuzzy_edit 连续失败熔断（FUZZY_FAIL_LIMIT = 3）
- Loop 自动继续：AI 无工具调用结束时可注入自定义文本续轮

## 模块职责边界

| 模块 | 管什么 | 不管什么 |
|------|--------|---------|
| endpoints.mjs | HTTP 参数校验 + 委派 | 不管生成逻辑 |
| requestBuilder.mjs | 请求对象组装 | 不管生成调度 |
| generation.mjs | 触发 -> 流式生成 -> 落盘 -> 续轮 | 不管提示词组装 |
| chatOps.mjs | 消息 CRUD + 写操作 | 不管 AI 生成 |
| chatStorage.mjs | 存储路径解析 + 持久化 | 不管消息操作 |
| prompt_struct.mjs | 提示词结构定义 + 序列化 | 不管插件调用 |

## RT-4 全局契约

所有改变 chatLog 后需要通知前端的操作，都必须先 `await saveChat`（落盘），再 `broadcastChatEvent`（WS 推送）。如果顺序反过来，前端收到 WS 事件后 refetch 端点可能读到旧数据。

## 导航

- [系统架构](architecture.md) — 整体架构
- [预设系统概览](../presets/overview.md) — 预设引擎
- [司令员模式](../presets/commander.md) — 五段拼装
- [插件概览](../plugins/overview.md) — 插件接口

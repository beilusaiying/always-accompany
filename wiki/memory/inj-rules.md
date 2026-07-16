# INJ规则配置

各条 INJ 规则的字段定义、门控逻辑和互斥关系。

## INJ 规则字段说明

每条 INJ 规则由以下字段定义：

| 字段 | 类型 | 说明 |
|------|------|------|
| **name** | 字符串 | 规则名称标识（如 INJ-1-chat） |
| **content** | 字符串 | 注入的内容模板，支持 `{{macro}}` 宏替换 |
| **autoMode** | 枚举 | 门控模式：chat/code/work/bot/always/all/manual/file（另可为自定义模式的域名） |
| **depth** | 数字 | 注入深度：999=系统级, 0=最新消息后, N=第N轮前 |
| **role** | 枚举 | 消息角色：system/user/assistant |
| **enabled** | 布尔 | 是否启用 |

## 默认 INJ 规则详解

### INJ-1-chat

- **autoMode**: `chat`
- **depth**: `999`（系统提示级）
- **role**: `system`
- **功能**: 向 AI 说明 chat 模式下的记忆表格系统。内容包括 #0-#9 各表的名称、存储内容、写入格式，以及 `<tableEdit>` 标签的语法说明。

**运行链**: 用户处于 chat 模式 → autoMode 匹配 → INJ-1-chat 的 content 作为 system 消息注入到上下文最前端（depth 999）→ AI 知道如何使用记忆表格。

### INJ-1-write-code

- **autoMode**: `code`
- **depth**: `999`
- **role**: `system`
- **功能**: 向 AI 说明 code 模式下的记忆表格系统。内容包括 C0-C5 各表的名称、存储内容、写入格式。

### INJ-1-work

- **autoMode**: `work`
- **depth**: `999`
- **role**: `system`
- **功能**: 向 AI 说明 work 模式下的记忆表格系统。内容包括 W0-W4 各表的名称、存储内容、写入格式。

### INJ-2

- **autoMode**: `file`（由文件层配置决定）
- **depth**: 可配置
- **role**: `system`
- **功能**: 注入来自角色文件或预设的额外 AI 提示词。这些提示词可能包含角色专属的行为指导、写作风格要求等。

**互斥**: 当 IDE 连接时，系统使用 INJ-2-code 变体替代 INJ-2。两者不会同时生效。

### INJ-3

- **autoMode**: `bot`
- **depth**: 可配置
- **role**: `system`
- **功能**: 注入 Bot 平台（如 Telegram、Discord）的专用提示词。包括平台特定的交互规则、消息格式限制等。

## autoMode 门控逻辑

```
收到消息，确定当前环境
    ↓
遍历所有 INJ 规则
    ↓
对每条规则检查 autoMode：
  chat   → 当前是 chat 模式？（含 airp 别名域）
  code   → 当前是 code 模式？
  work   → 当前是 work 模式？
  bot    → 当前是 Bot 平台接入？
  always / all → 直接通过（全模式）
  manual → 开启即生效
  file   → 当前是否文件/IDE 模式
    ↓
通过门控的 INJ 进入注入队列
    ↓
检查互斥关系，有冲突的只保留一条
    ↓
执行宏替换 → 按 depth 排序 → 注入上下文
```

## depth 与上下文位置

depth 值决定注入在上下文中的物理位置。理解 depth 需要先理解上下文的结构：

```
[depth 999] 系统提示区域
  ├─ 角色设定
  ├─ INJ-1 表格说明（depth 999）
  └─ 其他系统级 INJ
    ...
[depth N] 聊天历史区域
  ├─ 第 N 轮对话
  ├─ ...（世界书 atDepth 条目在此插入）
  ├─ 第 2 轮对话
  ├─ 第 1 轮对话
[depth 0] 最新消息区域
  └─ 用户的最新消息
```

depth 值越大越靠前（系统级），越小越靠近最新消息。

## 互斥规则详解

### INJ-1 系列互斥

三条 INJ-1（chat / write-code / work）通过 autoMode 自然互斥——同一时刻只有一种工作模式，因此只有一条 INJ-1 的 autoMode 会匹配。

### INJ-2 vs INJ-2-code

INJ-2 和 INJ-2-code 是同一位置的两个变体：

- **INJ-2**：标准文件层提示词，适用于普通对话场景
- **INJ-2-code**：IDE 连接时的文件层提示词，可能包含代码相关的额外指导

切换逻辑：系统检测到 IDE 连接 → 使用 INJ-2-code；未连接 → 使用 INJ-2。

## 宏替换详解

宏在 INJ content 中以 `{{宏名}}` 格式书写，注入时被替换为实际值。

**常用宏分类**：

| 类别 | 宏示例 | 说明 |
|------|--------|------|
| 角色信息 | `{{char}}`、`{{charName}}` | 当前角色名称 |
| 用户信息 | `{{user}}`、`{{userName}}` | 当前用户名称 |
| 时间信息 | `{{time}}`、`{{date}}`、`{{weekday}}` | 当前时间日期 |
| 系统信息 | `{{model}}`、`{{maxTokens}}` | 当前模型和配置 |
| 记忆信息 | `{{tableContent_N}}`、`{{memoryCount}}` | 记忆表格相关 |

宏替换的完整列表约 30 种，具体请参考宏系统文档。

## 自定义 INJ 规则

除了内置的多条 INJ，系统支持添加自定义规则。自定义规则需要指定：

1. 唯一的 name 标识
2. content 内容（支持宏）
3. autoMode 门控条件
4. depth 注入位置
5. role 消息角色

自定义规则与默认规则遵循相同的门控和注入逻辑。

## 调试建议

- 检查 INJ 是否生效：确认 autoMode 与当前模式匹配、enabled 为 true
- 检查注入位置：确认 depth 值是否符合预期
- 检查宏替换：确认 `{{macro}}` 是否被正确替换（拼写错误的宏不会被替换，会原样保留）
- 检查互斥冲突：如果预期的 INJ 没有生效，检查是否被互斥规则排除

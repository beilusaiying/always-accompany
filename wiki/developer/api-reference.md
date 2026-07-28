# API 端点参考

beilu-chat 的所有 HTTP/WS 路由在 `endpoints.mjs` 中定义。本文档列出主要端点及其功能。所有端点都通过 `authenticate` 中间件保护（需要登录）。详见[权限与鉴权](../security/auth.md)。

> **权威来源说明**：全项目（含各插件）的完整端点清单以仓库内开发者 Wiki 的 `docs/开发者Wiki/09_API端点参考.md` 为权威版本，两份文档如有出入以该文档及 `endpoints.mjs` 实际注册为准。本页只覆盖 beilu-chat Shell 自身的端点。

## 路由前缀

所有 beilu-chat 端点的基础路径为 `/api/parts/shells:chat/`（parts 框架约定路径 `/api/parts/{type}:{name}/...`，shell 类部件名为 `shells:chat`）。以下端点省略此前缀。

例如"发送消息"端点的完整路径是：

```
POST /api/parts/shells:chat/:chatid/message
```

## 对话消息操作

以 `:chatid` 为路径参数的端点，经过 `router.param("chatid")` 中央归属校验——验证请求用户是否有权操作该对话。

| 方法 | 路径 | 说明 |
|------|------|------|
| WS | `/ws/parts/shells:chat/ui/:chatid` | 聊天 UI WebSocket 连接（完整路径，不含 `/api` 前缀） |
| GET | `:chatid/initial-data` | 打开对话时获取初始化数据 |
| GET | `:chatid/log` | 获取 chatLog（支持分页） |
| GET | `:chatid/log/length` | chatLog 长度（`?visible=1` 仅未隐藏条目） |
| POST | `:chatid/message` | 用户发送消息（R1 入口，触发 AI 回复） |
| PUT | `:chatid/message/:index` | 编辑指定消息 |
| DELETE | `:chatid/message/:index` | 删除指定消息 |
| POST | `:chatid/trigger-reply` | 仅触发 AI 回复（不保存用户消息） |
| POST | `:chatid/messages/delete-range` | 批量删除消息范围 |
| POST | `:chatid/messages/hide` | 隐藏/取消隐藏消息范围 |
| PUT | `:chatid/timeline` | 切换时间线（greeting swipe） |
| GET | `:chatid/render/entries` | regex 激活修复：render 查询 |

## 对话生命周期

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `new` | 新建空对话 |
| DELETE | `delete` | 批量删除对话 |
| POST | `:chatid/rename` | 对话改名 |
| POST | `:chatid/mode` | 设置对话模式徽标 |
| POST | `:chatid/using` | 模式窗口在用指针（mode:char -> chatid） |
| POST | `branch` | 对话分叉 |
| GET | `getchatlist` | 获取聊天列表 |
| POST | `search` | 全文搜索聊天内容 |

## 对话元数据

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `:chatid/chars` | 对话内角色列表 |
| GET | `:chatid/plugins` | 对话内插件列表 |
| GET | `:chatid/persona` | 当前人设名 |
| GET | `:chatid/world` | 当前世界设定名 |
| POST | `:chatid/char` | 添加角色到对话 |

## 角色卡管理

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `create-char` | 创建空白角色卡 |
| PUT | `update-char/:charName` | 更新角色卡字段 |
| DELETE | `delete-char/:charName` | 删除角色卡（8 步清理） |
| POST | `import-char` | 导入角色卡 JSON/PNG（含正则 + 世界书迁移） |
| GET | `char/:charName/export` | 导出角色卡 PNG/JSON |
| GET | `char-data/:charName` | 获取 chardata.json |
| GET | `char-aisource/:charName` | 获取角色绑定 AI 源 + 可用源列表 |

## 人设管理

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `persona/create` | 创建人设 |
| DELETE | `persona/:name` | 删除人设 |
| PUT | `persona/:name/update` | 更新人设描述 + 头像 |

## IDE 桥接

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `ide/wstoken` | 浏览器代读 IDE WS token |
| POST | `ide/connect` | 强制后端 ideClient 立即连接 |
| POST | `ide/manual-tool-call` | 人工面板工具调用（走后端统一执行闸） |

## 多组并行管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `groups` | 列出本用户全部组 |
| POST | `groups` | 新建组 |
| PUT | `groups/:groupId` | 更新组字段 |
| DELETE | `groups/:groupId` | 删组（含终止 worker） |
| POST | `groups/:groupId/role` | 绑定组内角色到 chatid |
| DELETE | `groups/:groupId/role/:role` | 解绑组内角色 |
| GET | `groups/engine` | 并行引擎开关状态 |
| POST | `groups/engine` | 切换并行引擎开关 |
| POST | `groups/:groupId/execute` | 启动组内全部角色对话 |

## 插件配置端点

几乎每个插件都提供一对配置读写端点（在各插件实现体注册，非 beilu-chat 特有）：

| 操作 | 端点 | 说明 |
|------|------|------|
| 读配置/数据 | `GET /api/parts/plugins:<插件名>/config/getdata` | 调用插件的 GetData |
| 写配置/执行操作 | `POST /api/parts/plugins:<插件名>/config/setdata` | 调用插件的 SetData；写操作通过 body 里的 `_action` 字段路由到具体分支 |

例如切换模式走 `POST /api/parts/plugins:beilu-memory/config/setdata`，body 为 `{ "_action": "switchMode", "mode": "code" }`。各插件的 action 清单见 `docs/开发者Wiki/09_API端点参考.md`。

安全敏感的 config/setdata 写入经 `partConfigWriteNeedsOwner` 检测，命中时要求 owner 权限。

## WebSocket 事件

always-accompany 通过 WebSocket 实现实时通信。主要事件：

### 服务端 -> 客户端

| 事件 | 说明 |
|------|------|
| `message_added` | 新消息添加（用户消息 / AI 回复占位） |
| `message_replaced` | 消息被替换（AI 回复落定 / 隐藏范围更新） |
| `message_edited` | 消息被编辑 |
| `message_deleted` | 消息被删除 |
| `stream_start` | AI 流式回复开始 |
| `stream_update` | AI 流式回复新片段 |
| `token_usage` | Token 使用统计 |
| `typing_status` | 输入状态（多组并行时的对端活动指示） |
| `tool_results_ready` | IDE 工具结果就绪，触发自动继续 |
| `auto_continue_fuse` | 自动续轮熔断通知 |

### 客户端 -> 服务端

| 事件 | 说明 |
|------|------|
| `stop_generation` | 停止当前生成 |

## 认证要求

| 端点类型 | 认证级别 |
|---------|---------|
| 所有 API 端点 | authenticate（需登录） |
| 安全敏感配置 | requireOwner（需实例 owner） |
| API v1 外部调用 | API Key + scope 校验 |

## 错误响应

| 状态码 | 说明 |
|--------|------|
| 401 | 未认证（未登录或 token 过期） |
| 403 | 无权限（非 owner / 对话不属于当前用户） |
| 404 | 对话 / 角色 / 资源不存在 |
| 500 | 服务器内部错误 |

## 导航

- [系统架构](architecture.md) — 整体架构
- [消息管线](message-pipeline.md) — 消息流转
- [权限与鉴权](../security/auth.md) — 认证体系
- [插件开发](plugin-dev.md) — 自定义插件

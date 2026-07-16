# 执行链路

从 AI 输出到 IDE 实际执行的完整数据流。理解这条链路有助于排查工具调用失败的原因。

## 主链路：10 步执行流程

<div class="wiki-flow">
  <div class="wiki-box wiki-box-purple">
    <div class="wiki-label">1. AI 输出</div>
    AI 在回复中生成 &lt;ideToolCall&gt; 标签，包含工具名和参数
  </div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-purple">
    <div class="wiki-label">2. ReplyHandler 解析</div>
    消息管线的 ReplyHandler 拦截回复，解析出 ideToolCall 标签
  </div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-blue">
    <div class="wiki-label">3. 读写分流</div>
    判断工具类型：读操作直接放行，写操作进入安全检查
  </div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-red">
    <div class="wiki-label">4. 安全检查</div>
    五级安全闸逐级校验：命令闸 → 规则集 → 审批门 → 统一执行闸 → 指纹绑定
  </div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-amber">
    <div class="wiki-label">5. 审批队列</div>
    需审批的操作进入队列，前端弹出审批卡片等待用户批准或拒绝
  </div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-blue">
    <div class="wiki-label">6. callTool 调度</div>
    审批通过后，callTool 将请求封装为 WS 消息发往 YonBan 扩展
  </div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-green">
    <div class="wiki-label">7. WebSocket 传输</div>
    请求通过 WS 长连接送达本地 IDE 中运行的 YonBan 扩展
  </div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-green">
    <div class="wiki-label">8. ToolExecutor 执行</div>
    YonBan 扩展的 ToolExecutor 在本地 IDE 环境中执行实际操作
  </div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-blue">
    <div class="wiki-label">9. 结果回传</div>
    执行结果通过 WS 回传到 always-accompany 后端，入队等待处理
  </div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-purple">
    <div class="wiki-label">10. 注入下轮对话</div>
    工具执行结果注入到下一轮 AI 对话的上下文中，AI 据此决定后续操作
  </div>
</div>

## 四条调用路径

工具调用不只有 AI 主动发起一条路径，共有四条入口：

| 路径 | 触发方式 | 说明 |
|------|---------|------|
| AI 主动调用 | AI 回复中包含 `<ideToolCall>` | 主链路，经 ReplyHandler 解析后走完整安全闸 |
| 前端手动调用 | 用户在连接面板底部手动发送 | 选择工具 + 填参数 + 发送，跳过 AI 环节直接走 callTool |
| 分身调用 | 子模式/分身 AI 发起 | 与主链路相同，但可能绑定不同的权限等级 |
| dispatch 调度 | 系统内部自动触发 | 如自动快照（_checkpoint_start）、诊断推送等，内部工具不经审批 |

## WebSocket 消息类型

always-accompany 后端与 YonBan 扩展之间的 WS 通信使用以下消息类型：

| 消息类型 | 方向 | 说明 |
|---------|------|------|
| tool_call | 后端 → 扩展 | 工具调用请求，包含工具名和参数 |
| tool_result | 扩展 → 后端 | 工具执行结果，包含返回值或错误信息 |
| hello | 扩展 → 后端 | 连接握手，上报编辑器类型/版本 |
| status | 扩展 → 后端 | 扩展状态上报（打开文件/活动编辑器/诊断信息） |
| console | 扩展 → 后端 | IDE 终端/控制台输出转发 |
| ping / pong | 双向 | 心跳保活，检测连接存活 |

## 失败定位

工具调用失败时，沿链路逐步排查：

| 症状 | 可能的断点 |
|------|-----------|
| AI 没有调用工具 | 步骤 1 — 预设/提示词中未启用 IDE 工具 |
| 调用被拒绝 | 步骤 4-5 — 权限等级不足或被用户拒绝 |
| 调用超时无响应 | 步骤 7 — WS 连接断开，检查连接面板状态灯 |
| 执行报错 | 步骤 8 — 本地环境问题（文件不存在/权限不足） |
| AI 没有收到结果 | 步骤 9-10 — 结果回传或注入异常 |

## 导航

- [YonBan 概览](overview.md) — 安装与连接
- [工具列表](tools.md) — 30+ 工具速查
- [审批与权限](approval.md) — 五级安全闸详解
- [消息管线](beilu:wiki/developer/message-pipeline.md) — ReplyHandler 在管线中的位置

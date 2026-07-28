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
    审批通过后，callTool 将请求封装为 WS 消息；开了多个编辑器窗口时，按「对话 → 窗口」绑定关系路由到正确的那个窗口
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
| hello | 扩展 → 后端 | 连接握手，上报编辑器类型/版本/实例编号（多窗口身份识别的权威来源） |
| status | 扩展 → 后端 | 扩展状态上报（打开文件/活动编辑器/诊断信息） |
| question | 后端 → 扩展 | AI 向用户提问，等待用户在 IDE 侧回答 |
| question_answer | 扩展 → 后端 | 用户对 AI 提问的回答，回填给等待中的请求 |
| file_changed | 扩展 → 后端 | 文件被外部修改的通知——对应文件的读取缓存标记为「已变更」，AI 写前会被提示先重读 |
| diagnostics_changed | 扩展 → 后端 | 编译错误 / lint 变化推送，注入 AI 上下文触发自动修复（相同错误反复出现时有防死循环熔断：连续 3 次提示换思路，连续 6 次暂停注入） |
| console | 扩展 → 后端 | IDE 终端/控制台输出转发 |
| ping / pong | 双向 | 心跳保活，检测连接存活（长时间收不到 pong 判「僵连接」，主动断开重连） |

## 多窗口连接池

后端与编辑器之间**不是单条连接**，而是一个连接池：每个在线的 VSCode/Cursor 窗口（YonBan 实例）各占一条 WS 连接。要点：

- **每个窗口一条连接**：后端周期性扫描「活跃端口注册表」，新窗口上线自动接入，关掉的窗口自动剪除。
- **对话绑定窗口**：每个对话可以绑定到某个具体窗口，此后该对话的所有工具调用、快照、提问都只走那个窗口。绑定关系怎么建立、怎么自愈，见 [AI 操作后端](overview.md) 的多窗口一节。
- **窗口身份认「编号」不认端口**：端口重启后可能被别的窗口复用，所以每个窗口在握手时自报一个跨重启稳定的实例编号，路由时按编号校验「连在这个端口上的还是不是当初绑的那个窗口」。
- **宁可失败，不跨窗执行**：绑定的窗口关掉且找不到打开同一工作区的替代窗口时，工具调用会直接失败并说明原因，而不是悄悄把操作送进另一个窗口的工作区。

## 失败定位

工具调用失败时，沿链路逐步排查：

| 症状 | 可能的断点 |
|------|-----------|
| AI 没有调用工具 | 步骤 1 — 预设/提示词中未启用 IDE 工具 |
| 调用被拒绝 | 步骤 4-5 — 权限等级不足或被用户拒绝 |
| 调用超时无响应 | 步骤 7 — WS 连接断开，检查连接面板状态灯 |
| 提示「所绑窗口已断开，拒绝跨窗执行」 | 步骤 6 — 对话绑定的编辑器窗口已关闭；重新打开该工作区的窗口即可自动接回，或重新绑定 |
| 执行报错 | 步骤 8 — 本地环境问题（文件不存在/权限不足） |
| AI 没有收到结果 | 步骤 9-10 — 结果回传或注入异常 |

## 导航

- [YonBan 概览](overview.md) — 安装与连接
- [工具列表](tools.md) — 30+ 工具速查
- [审批与权限](approval.md) — 五级安全闸详解
- [消息管线](beilu:wiki/developer/message-pipeline.md) — ReplyHandler 在管线中的位置

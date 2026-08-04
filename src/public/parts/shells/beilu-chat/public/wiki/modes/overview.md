# 模式系统

按 Ctrl+1~4（或 Alt+1~4）切换模式，每个模式是一套独立的工作环境——不同的布局、面板和 AI 行为。

## 四大主模式

<div class="wiki-grid wiki-grid-2">
<div class="wiki-card" style="border-left-color: var(--wiki-amber, #f59e0b);">
<div class="wiki-card-title">Smart 全智能 <span class="wiki-badge">Ctrl+1 / Alt+1</span></div>
<div class="wiki-card-desc">三栏（左右可折叠）<br>人设管理、世界书、任务看板</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-amber, #f59e0b);">
<div class="wiki-card-title">Chat/AIRP 聊天 <span class="wiki-badge">Ctrl+2 / Alt+2</span></div>
<div class="wiki-card-desc">三栏<br>角色扮演对话、预设管理</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-amber, #f59e0b);">
<div class="wiki-card-title">Code/IDE 编程 <span class="wiki-badge">Ctrl+3 / Alt+3</span></div>
<div class="wiki-card-desc">IDE 样式（活动栏+侧边栏+主区）<br>代码编写、文件浏览、编程辅助</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-amber, #f59e0b);">
<div class="wiki-card-title">Work 工作 <span class="wiki-badge">Ctrl+4 / Alt+4</span></div>
<div class="wiki-card-desc">IDE 样式<br>任务管理、审批、委派、定时任务</div>
</div>
</div>

切换模式时，系统自动加载该模式绑定的预设、API 源和模型参数，AI 行为随之改变。

## 四大辅助视图

通过辅助菜单进入，提供管理和配置界面：

<div class="wiki-grid wiki-grid-2">
<div class="wiki-card" style="border-left-color: var(--wiki-blue, #3b82f6);">
<div class="wiki-card-title">Bot 管理 <span class="wiki-badge-blue">辅助菜单</span></div>
<div class="wiki-card-desc">多平台 Bot 配置与权限管理</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-blue, #3b82f6);">
<div class="wiki-card-title">Companion 游戏陪伴 <span class="wiki-badge-blue">辅助菜单</span></div>
<div class="wiki-card-desc">桌宠、Live2D、AI 自主行为</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-blue, #3b82f6);">
<div class="wiki-card-title">Memory 记忆管理 <span class="wiki-badge-blue">辅助菜单</span></div>
<div class="wiki-card-desc">记忆表格查看编辑、AI 预设运行</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-blue, #3b82f6);">
<div class="wiki-card-title">Helper ST 适配 <span class="wiki-badge-blue">辅助菜单</span></div>
<div class="wiki-card-desc">正则脚本、变量管理、ST 兼容工具</div>
</div>
</div>

## 子模式

[Code](beilu:mode/files) 和 [Work](beilu:mode/work) 模式各有 11 个子模式，用于更精细地划分工作阶段。每个子模式可独立绑定预设、API 源、模型和采样参数。详见 [子模式与切换](beilu:wiki/modes/submodes.md)。

## 全智能确认：AI 提议切模式，你拍板

在 Chat/Smart 模式对话中，AI 判断"这个任务该去 Code/Work 模式做"时，它只能**提出提案**，不能自己切过去执行：

1. **提案轮零副作用**：AI 输出模式切换提案的那一轮，被服务端硬门拦下——该轮的表格写入、工具调用、委派、归档等一切副作用全部不执行，也不自动续轮。提案就只是提案。
2. **确认卡**：前端弹出确认卡片，显示 AI 想切到哪个模式、要做什么。你点「确认」或「取消」。
3. **确认后**：请求经过单次认领（同一确认重复提交幂等去重，防重放）→ 自动补齐目标模式的专属对话 → 写入任务启动消息 → 触发目标模式的 AI 开始工作。取消则提案作废，什么都不发生。
4. **「已接受」≠「已完成」**：确认只代表任务已投递到目标模式，后续的运行、完成是独立状态，在目标窗口查看。
5. **Bot 场景有权限门**：来自外部平台、档位低于 L3 的触发者无法让 AI 发起模式切换提案。

待确认的提案也会作为数据注入提醒 AI，避免它忘了自己提过什么。

## 深入了解：两层模式架构

always-accompany 的模式分为两层：

| 层级 | 说明 | 可选值 |
|------|------|--------|
| 后端模式（B 通道） | 权威模式值，决定 AI 行为和预设加载 | `chat` / `smart` / `code` / `work` / `bot` |
| 前端 Tab（UI 视图） | 界面展示层，决定布局和面板 | `smart` / `chat` / `files` / `work` / `memory` / `bot` / `companion` / `helper` / `settings` / `editor` |

后端模式是权威源，前端 Tab 是视图层。一个后端模式可能对应多个前端 Tab（例如 `chat` 模式同时承载 Chat、Bot、Helper 等视图），但每个 Tab 最多映射到一个后端模式。

### 模式与 Tab 的映射关系

**正向映射**（后端模式 → 前端 Tab）：

<div class="wiki-layers">
<div class="wiki-layer wiki-layer-amber">
<b>后端模式（B 通道）</b>
<div class="wiki-row">
<div class="wiki-box wiki-box-amber"><b>chat</b><small>→ chat</small></div>
<div class="wiki-box wiki-box-amber"><b>smart</b><small>→ smart</small></div>
<div class="wiki-box wiki-box-amber"><b>code</b><small>→ files</small></div>
<div class="wiki-box wiki-box-amber"><b>work</b><small>→ work</small></div>
</div>
</div>
</div>

**反向映射**（前端 Tab → 后端模式）：

<div class="wiki-layers">
<div class="wiki-layer wiki-layer-amber">
<b>主模式 Tab（切换后端模式）</b>
<div class="wiki-row">
<div class="wiki-box wiki-box-amber"><b>chat</b><small>→ chat 聊天模式</small></div>
<div class="wiki-box wiki-box-amber"><b>airp</b><small>→ chat AIRP 角色扮演</small></div>
<div class="wiki-box wiki-box-amber"><b>smart</b><small>→ smart 全智能模式</small></div>
<div class="wiki-box wiki-box-amber"><b>bot</b><small>→ chat Bot 管理</small></div>
<div class="wiki-box wiki-box-amber"><b>helper</b><small>→ chat ST 适配</small></div>
<div class="wiki-box wiki-box-amber"><b>files</b><small>→ code IDE 编程</small></div>
<div class="wiki-box wiki-box-amber"><b>work</b><small>→ work 工作模式</small></div>
</div>
</div>
<div class="wiki-layer wiki-layer-blue">
<b>纯视图 Tab（不切换后端模式）</b>
<div class="wiki-row">
<div class="wiki-box wiki-box-blue"><b>memory</b><small>纯视图</small></div>
<div class="wiki-box wiki-box-blue"><b>companion</b><small>纯视图</small></div>
<div class="wiki-box wiki-box-blue"><b>settings</b><small>纯视图</small></div>
<div class="wiki-box wiki-box-blue"><b>editor</b><small>纯视图</small></div>
</div>
</div>
</div>

### 模式切换流程

用户触发模式切换后，系统执行以下流程：

<div class="wiki-flow">
<div class="wiki-box wiki-box-green wiki-box-full"><b>1. 用户操作</b><small>点击顶部选择器 / 按快捷键 / 点击辅助菜单</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-blue wiki-box-full"><b>2. switchTab(tabName)</b><small>前端切换 UI 视图</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-amber wiki-box-full"><b>3. switchModeTo(targetMode)</b><small>如果 Tab 映射了后端模式，触发后端模式切换</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-purple wiki-box-full"><b>4. 后端 switchMode</b><small>持久化模式值并广播给所有连接</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-green wiki-box-full"><b>5. 前端更新</b><small>收到广播后更新 UI、恢复对应的 chatId</small></div>
</div>

## 快速导航

- [聊天模式 (Chat/AIRP)](beilu:wiki/modes/chat.md) - 角色扮演与日常对话
- [编程模式 (Code/IDE)](beilu:wiki/modes/ide.md) - AI 辅助编程
- [工作模式 (Work)](beilu:wiki/modes/work.md) - 任务管理与工作流
- [Bot 模式](beilu:wiki/modes/bot.md) - 多平台 Bot 管理
- [游戏陪伴模式](beilu:wiki/modes/game.md) - 桌宠与 Live2D
- [子模式与切换](beilu:wiki/modes/submodes.md) - 子模式详解
- [多窗口与多开](beilu:wiki/modes/multi-window.md) - 同时开多个窗口、跨窗口唤醒与通知

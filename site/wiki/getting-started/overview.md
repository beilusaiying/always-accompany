# 欢迎来到 always-accompany

always-accompany 是一套本地、可编辑的 AI 系统。它把长期记忆、多种使用模式、工具插件和权限控制接在同一条运行链里。

你可以只把它当成聊天与陪伴应用，也可以继续使用 Code、Work、Bot、IDE、浏览器、MCP 和用户插件，把它改造成自己的 AI。

## 先判断它能不能帮到你

### 你会明显感受到价值的情况

| 你的目标 | always-accompany 提供的变化 |
|---|---|
| 和同一个角色长期聊天 | 历史进入可查看、可修改的记忆层；P1 在需要时召回相关旧事 |
| 从聊天切到编程或工作 | 角色与公共能力可以延续，模式表/目录和当前窗口运行态分区；同一角色卡的长期材料与任务清单仍共享 |
| 让 AI 操作本地环境 | 文件、终端、网页、浏览器、PPT、IDE/CLI 等能力通过插件接入 |
| 自己决定 AI 如何工作 | 预设、INJ、世界书、正则、记忆路由、权限和插件均可配置 |
| 在意数据与操作边界 | 本地存储、工作区沙箱、权限档位、审批和多用户隔离共同约束 |

### 你可能更适合别的工具

- 只需要嵌入现有应用的轻量记忆 SDK；
- 只想一次 API 调用完成，不想管理本地运行时和配置；
- 只需要一个成熟、专注的 IDE 助手；
- 无法接受自驱动 P1 当前约 2 GiB 级别的完整进程树开销。

always-accompany 的优势不是每一个单项都胜过专用产品，而是这些能力围绕同一个长期 AI 协同。

## 选择一条入门路径

### 路线 A：先聊天，再决定要不要深入

1. 在仓库根目录运行 `run.bat`；Linux / macOS 运行 `./run.sh`。启动脚本可能调用系统包管理器准备缺失组件，请先阅读脚本；
2. 打开 `http://localhost:1314` 并选择界面语言；
3. 按[AI 服务源配置](install.md)绑定 API 和模型；
4. 使用内置默认角色在 Chat 发送第一条消息；导入或创建其他角色卡是可选步骤；
5. 需要调整回复方式时再阅读[预设与参数](first-chat.md)；需要检查记忆时打开回复下方的记忆溯源卡。

适合：长期聊天、角色扮演、陪伴，以及想先体验记忆的人。

### 路线 B：直接做编程或工作

1. 在 Chat 中确认模型可用；
2. 切换到 Code 或 Work；
3. 设置 beilu-files 工作区根；
4. 先保留写入审批，再逐项开放需要的权限；
5. 按需求连接 YonBan IDE、CLI、联网、浏览器或 PPT。

适合：希望 AI 读取项目、修改文件、查资料或完成交付的人。

### 路线 C：搭自己的 AI

1. 先理解[预设系统](../presets/overview.md)与 [INJ 注入](../memory/inj-overview.md)；
2. 按场景组合[插件](../plugins/overview.md)；
3. 用世界书、MVU、正则、EJS 或 AIRP 改变状态与表现；
4. 需要外部能力时，通过用户插件宿主连接 Python、Node 或独立程序。

适合：想编辑提示词顺序与注入位置、自定义角色行为、游戏/叙事系统、传感器或本地服务，并逐层打造个人 AI 的极客与构建者。

## 系统是怎样组合起来的

<div class="wiki-flow">
<div class="wiki-box wiki-box-green wiki-box-full"><b>用户动作</b><small>消息、文件、语音、平台事件或定时任务</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-blue wiki-box-full"><b>模式 / 窗口线路</b><small>Chat、Code、Work、Bot、陪伴等入口决定本轮上下文与状态边界</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-purple wiki-box-full"><b>公共能力层</b><small>记忆、提示词、API、工具、权限、正则与渲染按配置参与</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-amber wiki-box-full"><b>持久化 / 执行端</b><small>用户与角色卡是硬边界；模式表和目录分区；异步结果按 owner / chatId 回传；角色卡任务清单仍共享</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-green wiki-box-full"><b>对应窗口读回</b><small>结果、审批、错误与通知回到正确的用户和窗口</small></div>
</div>

这也是为什么“功能很多”不能只写成一串名词。真正的价值在于：记忆知道该给谁，工具知道在哪个工作区执行，结果知道回到哪个窗口，权限知道谁可以批准。

## P1 和 P2 现在到底怎么运行

旧入门页写过“P1、P2 默认自动运行”，现在已经不准确。

### P1：可关闭，按模式选路

- P1 有插件级总开关；
- 每个模式可以选择 **自驱动 P1**、**AI P1** 或 **全部关闭**；
- 两条 P1 路线互斥，不会双跑，也不会偷偷互相降级；
- Chat、Code、Work 当前声明默认走自驱动 P1；
- Smart、Bot 当前声明仍走 AI P1；
- 用户覆盖会在下一轮对话生效。

自驱动 P1 不为每次召回调用 LLM，但需要本地常驻服务和词库资源。详细链路、测量值与限制见 [P1 当前运行架构](../p1-recall/ch7-current-runtime.md)。

### P2：不是默认自动能力

P2 的后台自动触发已经停止。当前手动按钮会以显式 `manual:true` 调用 `triggerP2Summary`，不再被 `manual_button` 的“跳过自动触发”守卫拦下；这证明调用链已经接通，不等于外部模型调用和最终归档质量已经完成真实验收。

机械归档与 P2 的 AI 整理是两条不同链路；前者成功，不等于后者的真实模型产物已经验收。

P3–P8 默认不作为新用户基础路径。需要使用时，请先查看对应预设、触发方式和当前实现状态。

## 插件默认也不是“全部自动工作”

当前源码包含 23 个内置插件目录，新用户模板列出 14 个默认插件。这里有三个容易混淆的状态：

1. 插件存在于源码；
2. 插件被当前用户或会话加载；
3. 插件内部的具体功能已经启用并配置完成。

例如 beilu-vectordb 在默认插件列表中，但语义向量检索本身默认关闭；只有配置 embedding 端点、模型与维度后才应开启。按目标和风险选择插件，请看[插件手册](../plugins/overview.md)。

## 开始前应该知道的边界

- 项目仍在高频更新，旧说明可能落后于代码；
- 本地运行意味着 API Key、模型下载、磁盘数据和权限由你负责；
- P1 已有后端白盒证据，但外部同任务质量 benchmark 尚未完成；
- 浏览器、IDE、Bot、多窗口与异步能力需要各自运行端，源码存在不等于真实环境已验证；
- server 多用户部署的安全默认比本地单用户更严格，不能照搬本地权限。

## 下一步

- [安装](install.md)
- [第一次对话](first-chat.md)
- [界面导览](ui-guide.md)
- [记忆系统](../memory/overview.md)
- [模式系统](../modes/overview.md)
- [插件手册](../plugins/overview.md)
- [安全中心](../security/overview.md)
- [YonBan 与工具执行](../yonban/overview.md)

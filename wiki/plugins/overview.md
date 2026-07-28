# 插件

在[插件管理](beilu:settings/plugins)面板查看和配置所有插件。always-accompany 内置 22 个插件，按功能分组如下。

## 插件列表

<div class="wiki-group">
<div class="wiki-group-title">核心插件 <span class="wiki-badge-red">核心</span></div>
<div class="wiki-grid wiki-grid-3">
<div class="wiki-card" style="border-left-color: var(--wiki-red, #ef4444);">
<div class="wiki-card-title">beilu-memory</div>
<div class="wiki-card-desc">记忆系统（表格/热层/归档/召回）</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-red, #ef4444);">
<div class="wiki-card-title">beilu-preset</div>
<div class="wiki-card-desc">预设引擎（提示词组装）</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-red, #ef4444);">
<div class="wiki-card-title">beilu-worldbook</div>
<div class="wiki-card-desc">世界书（关键词触发的背景注入）</div>
</div>
</div>
</div>

<div class="wiki-group">
<div class="wiki-group-title">工具插件 <span class="wiki-badge-green">工具</span></div>
<div class="wiki-grid wiki-grid-3">
<div class="wiki-card" style="border-left-color: var(--wiki-green, #22c55e);">
<div class="wiki-card-title">beilu-files</div>
<div class="wiki-card-desc">沙箱化文件读写删执行</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-green, #22c55e);">
<div class="wiki-card-title">beilu-web</div>
<div class="wiki-card-desc">联网搜索与网页浏览</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-green, #22c55e);">
<div class="wiki-card-title">beilu-ppt</div>
<div class="wiki-card-desc">PPT 生成（大纲/生成/迭代，产出 pptx）</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-green, #22c55e);">
<div class="wiki-card-title">beilu-browser</div>
<div class="wiki-card-desc">浏览器自动化（AI 操控真实 Chrome）</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-green, #22c55e);">
<div class="wiki-card-title">beilu-reach</div>
<div class="wiki-card-desc">平台触达（主流平台专用适配器）</div>
</div>
</div>
</div>

<div class="wiki-group">
<div class="wiki-group-title">感知插件 <span class="wiki-badge-blue">感知</span></div>
<div class="wiki-grid wiki-grid-3">
<div class="wiki-card" style="border-left-color: var(--wiki-blue, #3b82f6);">
<div class="wiki-card-title">beilu-eye</div>
<div class="wiki-card-desc">桌面截图感知 + Electron 桌宠</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-blue, #3b82f6);">
<div class="wiki-card-title">beilu-stt</div>
<div class="wiki-card-desc">语音转录（本地模型，说话代替打字）</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-blue, #3b82f6);">
<div class="wiki-card-title">beilu-live</div>
<div class="wiki-card-desc">直播弹幕接入（初筛后注入对话）</div>
</div>
</div>
</div>

<div class="wiki-group">
<div class="wiki-group-title">增强插件 <span class="wiki-badge">增强</span></div>
<div class="wiki-grid wiki-grid-3">
<div class="wiki-card" style="border-left-color: var(--wiki-amber, #f59e0b);">
<div class="wiki-card-title">beilu-regex</div>
<div class="wiki-card-desc">正则脚本引擎（AI 回复后处理）</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-amber, #f59e0b);">
<div class="wiki-card-title">beilu-mvu</div>
<div class="wiki-card-desc">变量系统（局部/全局变量读写）</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-amber, #f59e0b);">
<div class="wiki-card-title">beilu-ejs</div>
<div class="wiki-card-desc">EJS 模板渲染</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-amber, #f59e0b);">
<div class="wiki-card-title">beilu-toggle</div>
<div class="wiki-card-desc">条目动态开关（预设/世界书条目）</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-amber, #f59e0b);">
<div class="wiki-card-title">beilu-vectordb</div>
<div class="wiki-card-desc">向量数据库（语义检索）</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-amber, #f59e0b);">
<div class="wiki-card-title">beilu-airp</div>
<div class="wiki-card-desc">AIRP 渲染（DSL 标签渲染为彩色符号画）</div>
</div>
</div>
</div>

<div class="wiki-group">
<div class="wiki-group-title">基础与开发 <span class="wiki-badge-blue">基础/开发</span></div>
<div class="wiki-grid wiki-grid-3">
<div class="wiki-card" style="border-left-color: var(--wiki-purple, #8b5cf6);">
<div class="wiki-card-title">beilu-sysinfo</div>
<div class="wiki-card-desc">系统监控（CPU/内存/网络）</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-purple, #8b5cf6);">
<div class="wiki-card-title">beilu-logger</div>
<div class="wiki-card-desc">日志记录</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-purple, #8b5cf6);">
<div class="wiki-card-title">beilu-plugin-host</div>
<div class="wiki-card-desc">用户插件宿主</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-purple, #8b5cf6);">
<div class="wiki-card-title">beilu-tutorial</div>
<div class="wiki-card-desc">应用内教程 / wiki（本帮助页由它渲染）</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-purple, #8b5cf6);">
<div class="wiki-card-title">beilu-cli</div>
<div class="wiki-card-desc">CLI 工具后端（无需 IDE 的工具执行）</div>
</div>
</div>
</div>

## 插件配置

每个插件有独立的配置面板（在[插件管理](beilu:settings/plugins)中点击对应插件即可打开）。安全敏感的配置写入（如 beilu-files 的 allowExec、beilu-ejs 的 sandboxOptOut）需要实例 owner 权限。详见 [安全中心](../security/overview.md)（[前往安全中心](beilu:settings/security)）。

## 用户插件

通过 beilu-plugin-host，可以编写和加载自定义插件。用户插件与内置插件享有相同的接口能力。详见 [插件开发](../developer/plugin-dev.md)。

## 深入了解：插件接口

每个插件通过标准接口与核心系统交互：

### 数据接口

| 接口 | 方向 | 说明 |
|------|------|------|
| GetData | 核心 -> 插件 | 读取插件配置和状态 |
| SetData | 核心 -> 插件 | 写入插件配置或触发动作 |

### 消息管线接口

| 接口 | 调用时机 | 说明 |
|------|---------|------|
| GetPrompt | 消息发送前 | 返回插件要注入到提示词中的内容 |
| TweakPrompt | GetPrompt 之后 | 修改/调整已组装的提示词结构（三轮执行） |
| ReplyHandler | AI 回复后 | 解析 AI 回复中的标签/指令并执行 |
| GetReply | 生成调用时 | 拦截或修改 AI 调用请求 |

### 插件调用顺序

在一次完整的消息收发周期中，插件按以下顺序参与：

<div class="wiki-flow">
<div class="wiki-box wiki-box-green wiki-box-full"><b>用户发消息</b><small>触发消息管线</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-amber wiki-box-full"><b>1. GetPrompt</b><small>并行收集各插件的提示词片段</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-blue wiki-box-full"><b>2. TweakPrompt x 3 轮</b><small>Round 1 (dl=2): 收集清空 | Round 2 (dl=1): 重建消息序列 | Round 3 (dl=0): 快照</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-purple wiki-box-full"><b>3. StructCall</b><small>调用 AI API（由 provider/生成器执行）</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-red wiki-box-full"><b>4. ReplyHandler</b><small>解析 AI 回复中的操作标签</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-green wiki-box-full"><b>存储 + 广播</b><small>持久化消息并通知前端</small></div>
</div>

### 插件的加载

**默认插件**：always-accompany 启动时自动加载 `defaultParts.plugins` 中列出的插件。核心插件（memory / preset / worldbook 等）始终参与每次对话。

**对话级插件**：创建对话时，系统会将默认插件合并到对话的 timeSlice 中。后续添加到默认列表的插件也会自动加入。

## 快速导航

- [文件操作 (beilu-files)](files.md) — AI 文件读写
- [屏幕感知与桌宠 (beilu-eye)](eye.md) — 桌面截图与桌宠
- [语音转录 (beilu-stt)](stt.md) — 本地语音转文字
- [联网搜索 (beilu-web)](web.md) — 搜索与网页浏览
- [浏览器自动化 (beilu-browser)](browser.md) — AI 操控真实浏览器
- [平台触达 (beilu-reach)](reach.md) — 主流平台专用适配器
- [PPT 生成 (beilu-ppt)](ppt.md) — 从需求到 pptx
- [正则增强 (beilu-regex)](regex.md) — AI 回复后处理
- [变量系统 (beilu-mvu)](mvu.md) — 状态追踪
- [脚本引擎](scripts.md) — EJS 模板与脚本
- [插件开发](../developer/plugin-dev.md) — 编写自定义插件

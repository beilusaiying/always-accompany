# YonBan

在扩展市场装 YonBan，AI 就能直接操作你的 IDE——读写文件、执行命令、Git 操作等，30+ 工具全部通过审批系统管控。

## 安装

在 VSCode 或 Cursor 扩展市场搜索 **always-accompany**，安装 YonBan 扩展。

## 连接到 always-accompany

| 步骤 | 操作 |
|------|------|
| 1 | 安装扩展后，YonBan 自动连接 always-accompany 后端（默认端口 8931） |
| 2 | 扩展自动生成认证 Token，写入 `~/.beilu/ide_ws_token`，后端读取后完成 WebSocket 握手 |
| 3 | 连接建立后，前端进入[编程模式](beilu:mode/files)即可使用全部 IDE 工具 |

支持断线自动重连。

## 前端连接面板

在编程模式活动栏点击 connections 按钮打开连接面板。

**连接卡片**：面板显示 VSCode 和 Cursor 两张卡片，每张包含：

- 状态灯（绿 = 已连接 / 灰 = 断开）
- 编辑器版本号
- WebSocket 地址
- 当前会话时长

**操作按钮**：

- 重连 — 断线后手动重连
- 断开 — 主动断开当前连接
- 连接 — 连接到新的编辑器实例
- 指南 — 查看扩展安装与配置教程

**连接设置**：

| 设置 | 说明 |
|------|------|
| 自动重连 | 开关，断线后自动尝试重连 |
| 端口号 | 配置 WebSocket 端口（默认 8931） |
| 超时时间 | 连接超时阈值 |

**手动工具调用**：面板底部可手动向编辑器发送工具调用，用于调试或测试——选择目标 IDE、选择工具、填写参数 JSON、发送并查看结果。

## 导航

- [工具列表](tools.md) — 30+ 工具按分类速查
- [审批与权限](approval.md) — 权限等级与审批流程
- [执行链路](architecture.md) — 从 AI 输出到 IDE 执行的完整数据流
- [编程模式](beilu:wiki/modes/ide.md)（[进入](beilu:mode/files)） — IDE 模式完整界面说明

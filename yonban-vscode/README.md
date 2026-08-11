# YonBan — beilu IDE Bridge

将 [beilu-always-accompany](https://github.com/beilusaiying/always-accompany) 后端与 VSCode/Cursor 连接，为 AI 提供 IDE 工具执行能力（42 个 IDE 工具 + 侧边栏聊天/管理面板）。

---

## 快速开始

```bash
cd YonBan
npm install
npm run build        # esbuild 打 dist/
npx vsce package     # 打 .vsix 安装包
# 或 F5 启动 Extension Development Host
```

---

## 项目结构（与实际代码一致，改结构请同步本表）

```
YonBan/
├── src/
│   ├── extension.ts              ← 插件入口：服务组装 + 命令注册 + 诊断/文件变更广播
│   ├── YonBanProvider.ts         ← 左主侧栏 webview 消息中枢（80+ case 路由）
│   ├── constants.ts              ← 全局常量单一定义点（超时/轮询/上限/端口/默认模式）
│   ├── types.ts                  ← 三层共享类型契约
│   └── services/
│       ├── ConnectionService.ts  ← HTTP ping + 心跳重连状态机
│       ├── AuthService.ts        ← 登录 + Cookie + 统一 401-refresh-retry
│       ├── ChatService.ts        ← REST 封装 + 双 WS 通道（聊天流 + /ws/notify）
│       ├── IdeWsServer.ts        ← 本地 WS 服务器（承接本体 tool_call）
│       ├── ToolExecutor.ts       ← 42 工具路由中枢
│       ├── FileCheckpoint.ts     ← 文件快照/回档
│       ├── ConsoleCapture.ts     ← 宿主 console 拦截（→ 本体控制台面板 + webview 错误中心）
│       ├── EditorReveal.ts       ← 写后跳转高亮
│       ├── tool-infra.ts         ← 路径安全/日志/写后验证/提示共享层
│       ├── hintTexts.ts          ← 工具提示文本单源（yonban.hints.* 用户可覆盖）
│       └── tools/                ← 9 个工具实现模块（file/edit/search/command/git/doc/vscode/checkpoint/diagnostic/todo）
├── webview-ui/                   ← 侧边栏前端（IIFE + window.YB 命名空间，加载顺序见 YonBanProvider）
│   ├── chat-core.js              ← 基础设施（dom/state/toast/持久化/白盒环）
│   ├── chat-errors.js            ← 错误中心（宿主+界面错误持久面）
│   ├── chat-connection.js / chat-messages.js / chat-modes.js / chat-settings.js
│   ├── chat-prompt-viewer.js / chat-diagnostics.js / chat.js（入口路由）
│   └── chat.css / vendor-markdown.js（marked + DOMPurify）
├── package.json                  ← 插件清单 + 全部配置项声明
└── esbuild.js                    ← 构建脚本
```

---

## 配置项（单一权威=package.json contributes.configuration，本表随其同步）

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `yonban.serverUrl` | `http://localhost:1314` | 后端地址 |
| `yonban.sandboxServerUrl` | `http://localhost:13140` | 沙箱后端地址 |
| `yonban.sandboxMode` | `false` | 连沙箱实例而非生产实例 |
| `yonban.wsPort` / `yonban.sandboxWsPort` | `8931` / `18931` | IDE 桥接 WS 端口 |
| `yonban.autoConnect` / `yonban.autoStartWs` | `true` | 启动时自动连接/自动开 WS |
| `yonban.maxFileReferences` | `5` | 单条消息 @文件引用上限 |
| `yonban.hints.enabled` / `yonban.hints.overrides` | `true` / `{}` | 工具结果提示开关/逐键覆盖 |
| `yonban.autoRevealOnEdit` | `true` | AI 改文件后自动跳转高亮 |

---

## 开发文档

- [架构方案](beilu_worklog_YonBan_架构方案.md)（历史设计，现状以代码为准）
- [排查手册](TROUBLESHOOTING.md)

## 致谢

后端框架基于开源项目生态构建，来源致谢见 beilu-always-accompany 主仓库 README。
参考项目：Kilo Code（VSCode 插件架构）。

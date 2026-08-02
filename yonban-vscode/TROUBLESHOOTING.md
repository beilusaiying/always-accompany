# YonBan 排查手册 — 快速定位

> 遇到问题先查这里，按症状定位到文件和行号。

---

## 一、插件侧常见问题

### 1.1 侧边栏不显示 / 空白

**症状**：点击 Activity Bar 的 YonBan 图标，侧边栏空白或不出现。

**排查路径**：

| 步骤 | 检查内容                                                           | 文件                                            |
| ---- | ------------------------------------------------------------------ | ----------------------------------------------- |
| 1    | `package.json` 的 `contributes.views` 中 `id` 是否匹配             | [`package.json`](package.json) `"yonban.panel"` |
| 2    | `extension.ts` 的 `registerWebviewViewProvider` 第一个参数是否匹配 | [`extension.ts`](src/extension.ts)           |
| 3    | 看 Output → Extension Host 的日志有没有 `[YonBan]`                 |                                                 |
| 4    | 检查 `resolveWebviewView` 是否被调用                               | [`YonBanProvider.ts`](src/YonBanProvider.ts) |

**常见原因**：

- `package.json` 中的 view id 和 `registerWebviewViewProvider` 的 id 不一致
- esbuild 构建失败，`dist/extension.js` 没有更新
- VSCode 缓存了旧版本，需要 `Developer: Reload Window`

---

### 1.2 连接后端失败

**症状**：状态显示"连接错误"或"后端无响应"。

**排查路径**：

| 步骤 | 检查内容                                     | 文件                                                               |
| ---- | -------------------------------------------- | ------------------------------------------------------------------ |
| 1    | 后端是否在运行                               | 浏览器访问 `http://localhost:7860/api/ping`                        |
| 2    | `yonban.serverUrl` 配置是否正确              | VSCode Settings → yonban.serverUrl                                 |
| 3    | `ConnectionService.ping()` 的 fetch 是否超时 | [`ConnectionService.ts`](src/services/ConnectionService.ts)     |
| 4    | 是否有 CORS 问题                             | 后端 `/api/ping` 已有 `cors()` 中间件                              |
| 5    | Cookie 是否正确传递                          | [`AuthService.ts`](src/services/AuthService.ts) `getHeaders()` |

**快速验证命令**：

```bash
# 在终端测试后端是否可达
curl http://localhost:7860/api/ping
```

---

### 1.3 登录失败

**症状**：输入用户名密码后提示"登录失败"。

**排查路径**：

| 步骤 | 检查内容                             | 文件                                               |
| ---- | ------------------------------------ | -------------------------------------------------- |
| 1    | 后端 `/api/login` 返回什么状态码     | 浏览器 F12 Network                                 |
| 2    | 密码是否正确（空密码也要传空字符串） | [`AuthService.ts`](src/services/AuthService.ts) |
| 3    | 登录响应中是否包含 `accessToken`     | [`AuthService.ts`](src/services/AuthService.ts) |
| 4    | Node.js fetch 的 Set-Cookie 解析     | [`AuthService.ts`](src/services/AuthService.ts) |

**注意**：Node 18+ 的 `fetch` 不会自动处理 Cookie，需要手动从响应体/Set-Cookie 头提取 token。

---

### 1.4 构建失败

**症状**：`npm run build` 报错。

**排查路径**：

| 步骤 | 检查内容                             | 文件                           |
| ---- | ------------------------------------ | ------------------------------ |
| 1    | TypeScript 类型错误                  | 运行 `npx tsc --noEmit`        |
| 2    | esbuild 错误                         | [`esbuild.js`](esbuild.js)     |
| 3    | 依赖是否安装                         | `npm install`                  |
| 4    | `@types/vscode` 版本是否匹配 engines | [`package.json`](package.json) |

---

### 1.5 Webview 内容不更新

**症状**：修改了 `YonBanProvider.ts` 中的 HTML，但侧边栏没变。

**排查路径**：

1. 确认 `npm run build` 已执行
2. 在 Extension Development Host 中执行 `Developer: Reload Window`
3. 如果用 watch 模式，确认 esbuild watcher 没有报错

---

## 二、后端侧常见问题（Phase 1B+ 才会遇到）

### 2.1 `/ws/ide` WebSocket 连接不上

**排查路径**：

| 步骤 | 检查内容                                            | 文件                        |
| ---- | --------------------------------------------------- | --------------------------- |
| 1    | 后端是否注册了 `/ws/ide` 路由                       | `endpoints.mjs` 末尾        |
| 2    | WebSocket 升级是否通过认证                          | `authenticate` 中间件       |
| 3    | 插件侧 WebSocket URL 是否正确（ws:// 不是 http://） | `IdeChannel.ts`（Phase 1B） |

### 2.2 宏不展开

**排查路径**：

| 步骤 | 检查内容                                                     | 文件                           |
| ---- | ------------------------------------------------------------ | ------------------------------ |
| 1    | `ide_state.mjs` 中 `getIdeConnection()` 返回 null            | `ide_state.mjs`（Phase 1C）    |
| 2    | `buildMacroEnvFromPromptStruct()` 是否设置了 `env.ide_tools` | `beilu-preset/main.mjs` L1370+ |
| 3    | 提示词查看器中查看 INJ-1-code 的内容                         | 后端 UI 面板                   |

### 2.3 `<tool_call>` 不触发工具执行

**排查路径**：

| 步骤 | 检查内容                             | 文件                          |
| ---- | ------------------------------------ | ----------------------------- |
| 1    | AI 输出中是否包含 `<tool_call>` 标签 | 检查 AI 原始回复              |
| 2    | `parseToolCallTags()` 能否正确解析   | `replyParser.mjs`（Phase 1D） |
| 3    | IDE WebSocket 是否连接               | 后端日志 `[ide]`              |
| 4    | 工具执行是否超时（30s）              | `ToolExecutor.ts`（Phase 1B） |

---

## 三、调试启动问题

### 3.0 F5 提示"选择调试器"或要求 Markdown 调试器

**症状**：按 F5 后弹出"Select a debugger"对话框，或提示需要安装 Markdown 调试器。

**原因**：在多根工作区（multi-root workspace）中，如果当前活动编辑器打开的是 `.md` 文件，Cursor/VSCode 会尝试调试当前文件，而不是使用 `YonBan/.vscode/launch.json` 中的配置。

**解决方法（任选其一）**：

| 方法               | 操作                                                                                                                         |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| **方法 A（推荐）** | 打开 Run and Debug 面板（`Ctrl+Shift+D`），在顶部下拉框中选择 **"Run YonBan Extension (YonBan 插件)"**，然后点击绿色三角按钮 |
| **方法 B**         | 先点击 `YonBan/` 目录下的任意 `.ts` 文件使其成为活动编辑器，然后再按 F5                                                      |
| **方法 C**         | 直接用 VSCode/Cursor 打开 `YonBan/` 文件夹（不使用多根工作区），F5 就能直接工作                                              |

**验证**：启动成功后会弹出一个新的 "Extension Development Host" 窗口，窗口标题栏会显示 `[Extension Development Host]`。

---

## 四、开发环境排查

### 4.1 如何查看插件日志

1. 在 Extension Development Host 窗口中：`Ctrl+Shift+U` → 选择 "Extension Host" 通道
2. 搜索 `[YonBan]` 前缀

### 4.2 如何查看 Webview 开发者工具

1. 在 Extension Development Host 窗口中：`Ctrl+Shift+P` → `Developer: Open Webview Developer Tools`
2. 在 Console 中查看 webview 内的日志

### 4.3 如何查看后端日志

1. 后端控制台输出带有 `[ide]` 前缀的日志（Phase 1B+ 才有）
2. 或访问 `http://localhost:7860` 的 IDE 监控面板

### 4.4 热重载

```bash
# 插件侧：watch 模式（修改 .ts 文件自动重新构建）
cd YonBan && npm run watch

# 后端：Deno 有自动重启机制，修改 .mjs 文件后会自动重载
```

---

## 五、错误码速查

| 错误信息                       | 原因                             | 解决                               |
| ------------------------------ | -------------------------------- | ---------------------------------- |
| `后端无响应`                   | 后端未启动或地址错误             | 检查 `yonban.serverUrl` 和后端进程 |
| `登录凭据已失效`               | Cookie 过期                      | 重新登录                           |
| `心跳丢失`                     | 网络中断或后端重启               | 自动重连（5s 后）                  |
| `Not connected to CLI backend` | Kilo Code 的错误，不是 YonBan 的 | 检查是否混淆了两个插件             |

---

*最后更新：2026-03-19*

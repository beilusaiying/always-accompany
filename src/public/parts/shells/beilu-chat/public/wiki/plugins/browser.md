# 浏览器自动化 (beilu-browser)

beilu-browser 让 AI 能够控制一个真实的 Chrome 浏览器。AI 通过 `<browser_op>` 标签发起浏览器操作，插件解析标签、执行操作、将结果注入下一轮对话。

> 沿革说明：早期版本另有一条"前端触发浏览器页面快照注入消息"的通道，已于 2026-07-16 移除。现在的浏览器自动化统一走本页描述的 `<browser_op>` 对话内标签协议——插件本体持续维护中，并未随旧通道一起删除。

## 工作原理

```
AI 回复中包含 <browser_op> 标签
    ↓
ReplyHandler 解析标签
    ↓
调用 browser-driver 执行操作（CDP WebSocket → Chrome）
    ↓
结果存入待注入队列（按会话隔离）
    ↓
下一轮 GetPrompt 将结果注入对话
    ↓
AI 看到结果，决定下一步操作
```

## 前置条件

Chrome 需以远程调试模式启动。最简单的方式：在「额外插件 → 浏览器自动化」面板点击**启动 Chrome**按钮（自动检测 Chrome 路径并以正确参数启动）。

手动启动等价命令：

```
chrome --remote-debugging-port=9222 --user-data-dir=data/browser-profile
```

- `--remote-debugging-port` 端口号可在插件配置中修改
- `--user-data-dir` 独立用户目录（默认在 beilu 数据目录下，可在面板配置），共享登录态

## 操作标签

### 导航

| 标签 | 说明 |
|------|------|
| `<browser_op type="goto" url="https://..." />` | 打开指定 URL |
| `<browser_op type="tabs" />` | 列出所有标签页 |
| `<browser_op type="newtab" url="https://..." />` | 打开新标签页 |
| `<browser_op type="closetab" />` | 关闭当前标签页 |
| `<browser_op type="sync" />` | 同步到你正在浏览的标签页（人机共享同一浏览器，AI 接续你所在的页面操作） |

### 页面检查

| 标签 | 说明 |
|------|------|
| `<browser_op type="snapshot" />` | 获取页面无障碍树（accessibility tree），每个元素带 @N 引用号 |
| `<browser_op type="screenshot" />` | 截取页面截图，保存为 PNG |

### 交互操作

使用 snapshot 返回的 @N 引用号定位元素：

| 标签 | 说明 |
|------|------|
| `<browser_op type="click" target="@3" />` | 点击元素 |
| `<browser_op type="type" target="@3" value="输入文字" />` | 在输入框中输入文字 |
| `<browser_op type="press" key="Enter" />` | 按下键盘按键 |
| `<browser_op type="scroll" dy="300" />` | 滚动页面（dy 正值向下，负值向上） |

### JavaScript 执行

```xml
<browser_op type="eval">document.title</browser_op>
```

### 等待

```xml
<browser_op type="wait" selector="css:.result" timeout="5000" />
```

### 浏览内容记录

```xml
<browser_op type="history" />
```

开启「浏览内容记录」后，每次浏览器操作的页面 URL、标题与结果摘要会记录到本地文件（默认 `data/browser-history.jsonl`）。AI 通过 `history` 操作回读最近记录，实现跨轮浏览记忆；记录开关与回读条数可在面板配置。

## 典型工作流

1. `goto` 导航到目标页面
2. `snapshot` 查看页面结构，获取元素的 @N 引用号
3. `click` / `type` 与页面交互
4. `snapshot` 再次查看结果，确认操作成功
5. 重复直到任务完成

## 宏

beilu-browser 通过 macro_env 提供以下宏，可在 INJ 条目或预设中使用：

| 宏 | 说明 |
|----|------|
| `{{browser_status}}` | 浏览器连接状态（connected / disconnected） |
| `{{browser_port}}` | CDP 调试端口号 |

## INJ 条目

插件首次加载时自动创建 `INJ-browser` 条目，包含 AI 的浏览器操作能力说明。你可以在 INJ 编辑器中自由修改其内容、深度、模式门控等设置。

- **默认深度**: 1（system 区域）
- **默认模式**: always（全模式生效）
- **支持宏**: 内容中可使用 `{{browser_status}}`、`{{browser_port}}` 等宏

## 配置项

全部配置可在「额外插件 → 浏览器自动化」面板设置：

| 配置 | 默认值 | 说明 |
|------|--------|------|
| enabled | true | 插件总开关 |
| port | 9222 | Chrome 远程调试端口 |
| snapshotMaxLines | 200 | 快照最大行数（防止超长页面撑爆上下文） |
| chromePath | 空（自动检测） | Chrome 可执行文件路径 |
| userDataDir | data/browser-profile | Chrome 用户数据目录（相对 beilu 数据目录） |
| driverPath | 空（内置驱动） | 留空使用随 beilu 分发的内置驱动，可指定外部驱动 file:// URL |
| defaultTimeout | 5000 | wait 操作默认超时（ms） |
| defaultScrollDy | 300 | scroll 默认滚动量（px） |
| gotoWaitUntil | load | 导航等待策略（load / domcontentloaded / commit） |
| resultLabel / resultSeparator | — | 结果注入的区块标题与分隔符 |
| autoReconnect | true | 操作失败后自动重连 |
| recordBrowsing | true | 浏览内容记录开关 |
| historyFile | data/browser-history.jsonl | 浏览记录落盘文件 |
| historyMaxRead | 30 | history 操作默认回读条数 |

## 启动、熔断与通知

- **按需自启**：启动期不再无条件拉起 Chrome，只在真正要用浏览器时才自动启动；断连后会自动重新拉起 Chrome 进程并轮询重附着（尊重 `autoReconnect=false`）。
- **连续失败熔断**：10 秒内连续 2 次拉起后端口仍不就绪会触发熔断，提示"疑似同配置 Chrome 已在运行，请关闭后在面板点同步重试"——面板的**「同步」按钮就是熔断复位口**（同时也是"接续你正在浏览的标签页"的入口）。
- **操作可见**：AI 每次操作浏览器前，前端会弹 toast「AI 正在操作浏览器」+ 桌面通知 + 提示音；完成提示音音量可在面板调节（默认 0.5）。

## 安全

- **内网防护**：`goto` / `newtab` 的 URL 经统一出站安全校验（safe_fetch），私网/回环/云元数据地址一律拒绝——AI 无法驱动浏览器探测内网。
- **内容边界**：网页标题、快照、eval 结果等外部内容注入 AI 前经不可信内容边界处理（尖括号中性化 + 随机 nonce 边界标注），阻断网页内容对 AI 的间接指令注入。

## 技术架构

底层驱动内置于插件目录（`beilu-browser/driver/`，随 beilu 本体分发，零外部依赖），通过 Chrome DevTools Protocol (CDP) 原生 WebSocket 直接控制浏览器：

- 不依赖 Playwright/Puppeteer，零 npm 依赖
- 支持 Playwright 风格的 Locator API（CSS / role / text / xpath）
- Input Probe 回退机制：CDP 原生事件失败时自动用 synthetic event 补发
- Session 自愈：标签页关闭/导航后自动重附着，preferredTarget 跟随切换

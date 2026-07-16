# 安全中心

[设置 → 安全中心](beilu:settings/security)查看安全状态，管理安全策略。

## 快速操作

1. 打开[安全中心](beilu:settings/security)面板
2. 查看面板顶部的 **安全总结**，了解当前安全状态
3. 点击 **一键安全检查**，扫描所有检查项并汇总结果
4. 在检查项列表中逐项查看和调整安全策略

### 面板控件一览

| 控件 | 说明 |
|------|------|
| 安全总结 | 面板顶部展示当前安全状态概览 |
| 一键安全检查 | 按钮，扫描所有检查项并汇总结果 |
| 检查项列表 | 根据检查项类型动态渲染不同控件（下拉选择 / 开关 / EJS 配置 / 列表），用于逐项查看和调整安全策略 |
| 内容过滤 — 黑名单关键词 | 文本输入，配置需要过滤的关键词 |
| 内容过滤 — 用户名过滤 | 文本输入，配置需要过滤的用户名 |
| iframe 安全等级 | 3 档选择，控制 iframe 嵌入的限制级别 |

检查项列表中的每一项对应一个具体的安全策略（如部署模式、命令执行、沙箱配置等），owner 可在此集中管理，无需逐个进入插件配置。

## 切换部署模式

always-accompany 区分两种部署模式，安全策略随之调整：

### local 模式（默认）

适用于个人本地使用。安全策略相对宽松：

- 文件操作默认在工作区内放行
- 命令执行默认允许
- 软链接不做实路径校验
- 唯一用户即 owner

### server 模式

适用于多用户共享部署。安全策略收紧：

- 命令执行默认关闭，需 owner 显式开启
- 软链接做实路径校验（防软链逃逸）
- 安全敏感配置写入需 owner 权限
- 无效的部署模式值回退到 server（fail-safe）

通过环境变量 `BEILU_DEPLOY_MODE=server` 或安全中心面板设置 `config.deployMode` 切换。

## 管理插件安全配置

以下插件配置的修改需要 owner 权限（在[插件管理](beilu:settings/plugins)面板配置）：

| 插件 | 敏感配置 | 风险 |
|------|---------|------|
| beilu-files | allowExec / rootPath / workspaceRoot | 开启命令执行 / 改沙箱边界 |
| beilu-ejs | sandboxOptOut | 关闭 EJS 沙箱 |
| beilu-regex | regexGuard | 关闭 ReDoS 防护 |

这些配置的写入在 parts_router 的 config/setdata 入口被统一拦截（`partConfigWriteNeedsOwner`），而非在各插件内部各自拦截。

## 三个核心原则

1. **安全默认**：所有安全开关默认处于最安全状态，需要主动开启高风险功能
2. **Owner 可控**：安全策略由实例 owner 掌控，普通用户无法修改安全敏感配置
3. **纵深防御**：每个安全域（路径/网络/执行/认证）都有多层防护，单层被绕过不会导致全面失守

## 安全架构总览

| 安全域 | 核心机制 | 保护目标 |
|--------|---------|---------|
| 认证鉴权 | JWT + API Key + 暴力破解防御 | 用户身份 |
| 路径围栏 | confinePath + confineSegment | 文件系统 |
| 对话归属 | router.param("chatid") 中央校验 | 对话数据 |
| 内容安全 | CSP + WS Origin 校验 | 前端安全 |
| 执行门控 | deployGatedAllow | 命令执行 |
| 插件安全 | partConfigWriteNeedsOwner | 插件配置 |
| 令牌闸 | pet-token 鉴权 | 截图注入 |

## 文件操作安全

beilu-files 的四层纵深防御：

1. **路径规范化**：消化 `..`、绝对路径注入，将路径锚定到工作区
2. **系统路径阻断**：阻止访问系统敏感目录和文件
3. **工作区沙箱**：所有操作必须在 workspaceRoot 内
4. **白名单/黑名单**：精细化路径控制

详见 [文件操作 (beilu-files)](../plugins/files.md)。可在[插件管理](beilu:settings/plugins)面板配置。

## 对话数据保护

### 归属校验

所有以 `:chatid` 为路径参数的端点，都通过 `router.param("chatid")` 中央归属校验——验证请求用户是否是该对话的 owner。未通过校验的请求返回 403。

### Body 中的 chatid

部分端点通过请求体传递 chatid（如 manual-tool-call、group bind、branch），这些端点有独立的 inline 校验逻辑。

## 网络安全

- **CSP（内容安全策略）**：已实装，限制可加载资源的来源
- **WS Origin 校验**：WebSocket 连接时校验 Origin 头，防止跨站 WebSocket 劫持
- **safeFetch**：联网请求通过安全抓取函数，内置超时和恶意 URL 过滤

## 多用户隔离

在 server 模式下，always-accompany 对以下数据进行用户级隔离：

- 对话数据和聊天历史
- 预设配置和预设文件
- 插件配置（通过 AsyncLocalStorage 实现 per-user 隔离）
- 文件操作的工作区配置
- 记忆系统数据

## 导航

- [权限与鉴权](auth.md) — JWT / API Key / 权限分级详解
- [文件操作 (beilu-files)](../plugins/files.md) — 文件安全机制
- [插件概览](../plugins/overview.md) — 插件安全配置

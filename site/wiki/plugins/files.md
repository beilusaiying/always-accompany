# 文件操作 (beilu-files)

beilu-files 让 AI 能够在你的电脑上读写文件和执行命令。它是 [IDE模式](beilu:mode/files) 和 [工作模式](beilu:mode/work) 的核心工具插件——AI 通过它浏览目录、读取代码、写入文件、执行终端命令。

所有文件操作都在沙箱内执行，受多层安全机制保护。

## 支持的操作

| 操作类型 | 说明 | AI 标签 |
|---------|------|--------|
| read | 读取文件内容 | `<file_op>` / `<tool_call>` |
| write | 写入/覆盖文件 | `<file_op>` / `<tool_call>` |
| create | 创建新文件 | `<file_op>` / `<tool_call>` |
| delete | 删除文件 | `<file_op>` / `<tool_call>` |
| list | 列出目录内容 | `<file_op>` / `<tool_call>` |
| move | 移动/重命名文件 | `<file_op>` / `<tool_call>` |
| exec | 执行终端命令 | `<file_op>` / `<tool_call>` |

## 安全架构

beilu-files 采用四层纵深防御，每个文件操作（无论来源）都必须通过：

### 第一层：路径规范化（resolveCanonicalOpPath）

将相对路径锚定到工作区根目录，消化 `..`（父目录引用），防止通过路径拼接逃出沙箱。

### 第二层：系统路径阻断（checkSystemDriveBlock）

阻断对系统敏感路径、敏感文件扩展名和关键词的访问。

### 第三层：工作区沙箱

所有操作必须在工作区根目录（workspaceRoot）内执行。超出工作区边界的路径一律拒绝。

### 第四层：白名单/黑名单

精细化的路径允许/禁止列表。使用前缀 + 边界分隔符比较（防止 `/a/b` 误拦 `/a/bc`）。

### 三条路径共用

无论操作来自哪个入口，都必须通过同一个安全闸：

- **AI 路径**：AI 回复中的 `<file_op>` / `<tool_call>` 标签
- **前端路径**：用户通过 UI 直接操作文件
- **审批路径**：用户审批通过待处理的操作

## 操作流程

### AI 发起的操作

```
AI 回复包含文件操作标签
    ↓
ReplyHandler 解析操作
    ↓
Bot 权限闸（N42，检查 Bot 来源的访问档位）
    ↓
always 规则检查（N46）
    ↓
权限开关检查
    ↓
validateOpSecurity（四层纵深安全校验）
    ↓
自动审批 / 进入待审批队列
    ↓
executeFileOperation（磁盘操作）
    ↓
结果进入 pendingOpResults 队列
    ↓
下一轮 GetPrompt 注入结果，AI 看到执行结果继续工作
```

### 审批机制

某些操作（如写入、删除、执行命令）默认需要用户审批：

- **自动审批**：读取操作通常自动通过
- **待审批队列**：写入/删除/执行进入队列，等待用户在前端确认
- **批量审批**：可以一键批准所有待处理操作

## 命令执行（exec）

exec 类型操作允许 AI 执行终端命令。由于安全风险较高，它受到额外的门控保护：

- **deployGatedAllow 门控**：本地部署（local 模式）默认放行；服务器部署（server 模式）默认关闭，需要实例 owner 在安全中心显式开启
- 可通过配置面板控制 `allowExec` 开关
- 可通过环境变量 `BEILU_FILE_EXEC=on` 强制开启

## 文件历史

beilu-files 会记录文件操作历史，支持回滚到之前的版本。写入操作前自动保存旧版本，出问题可以恢复。

## GitHub 集成

beilu-files 包含 GitHub 集成模块，支持通过 GitHub API 进行仓库操作。

## 工作区设置

### workspaceRoot

工作区根目录是 beilu-files 的沙箱边界。所有文件操作必须在此目录内。可以在插件配置中设置。

### workspaceRoots

多工作区支持。可以配置多个工作区根目录，AI 可以在这些目录间切换。

## 多用户隔离

在多用户场景下，beilu-files 使用 AsyncLocalStorage 实现 per-user 隔离。工作区配置等字段按用户独立存储，不同用户互不影响。

## 导航

- [插件概览](overview.md) — 插件系统简介
- [安全中心](../security/overview.md)（[打开面板](beilu:settings/security)） — 安全策略总览
- [权限与鉴权](../security/auth.md) — 权限分级

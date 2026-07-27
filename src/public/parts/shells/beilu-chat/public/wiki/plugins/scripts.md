# 脚本引擎

always-accompany 提供 EJS 模板渲染能力（beilu-ejs 插件），允许在预设条目和角色卡中使用 EJS 模板语法编写动态内容。这比简单的宏替换更强大，可以实现条件判断、循环、复杂计算等逻辑。

## EJS 模板引擎 (beilu-ejs)

### 基本语法

EJS（Embedded JavaScript）允许在文本中嵌入 JavaScript 代码：

| 标签 | 说明 | 示例 |
|------|------|------|
| `<% %>` | 执行 JS 代码（不输出） | `<% if (x > 5) { %>` |
| `<%= %>` | 输出表达式结果（HTML 转义） | `<%= user %>` |
| `<%- %>` | 输出表达式结果（不转义） | `<%- rawHtml %>` |

### 可用的模板变量

EJS 模板在执行时可以访问宏环境中的变量，包括：

- `char` — 角色名
- `user` — 用户名
- 自定义变量（通过 beilu-mvu 设置的变量）
- 其他宏环境中的值

### 沙箱安全

beilu-ejs 默认在沙箱中执行 EJS 模板，限制可访问的全局对象和 API，防止恶意代码执行。

**sandboxOptOut** 是一个安全敏感开关：关闭沙箱后 EJS 可以访问完整的 Node.js 环境（包括文件系统、网络等），这在多用户环境下有严重安全风险。因此 sandboxOptOut 的修改需要实例 owner 权限。

### 使用场景

| 场景 | 说明 |
|------|------|
| 条件指令 | 根据模式/变量值切换不同的系统提示 |
| 动态列表 | 根据角色关系数据生成人物列表 |
| 复杂格式化 | 将结构化数据渲染为 AI 友好的文本 |
| 计算与统计 | 在预设中进行数值计算 |

## 用户插件脚本 (beilu-plugin-host)

### 概述

beilu-plugin-host 允许用户编写和加载自定义 JavaScript 插件脚本。用户插件与内置插件享有相同的接口能力（GetPrompt / TweakPrompt / ReplyHandler 等）。

### 安全限制

用户插件脚本的执行同样受安全策略管控。在服务器部署模式下，用户插件的子进程 spawn 需要 owner 显式授权。

## change-prompt 生成器

change-prompt 是一个特殊的服务生成器，允许在预设条目中使用 `${}` 语法进行模板求值。它也受 deployGatedAllow 门控保护。

## 脚本的执行时机

| 引擎 | 执行阶段 | 说明 |
|------|---------|------|
| EJS (beilu-ejs) | 宏替换阶段 | 在 evaluateMacros 过程中执行 |
| 正则 (beilu-regex) | TweakPrompt / ReplyHandler | 在消息发送前/回复后执行 |
| 用户插件 (plugin-host) | GetPrompt / TweakPrompt / ReplyHandler | 与内置插件同时机 |

## 导航

- [插件概览](overview.md) — 插件系统简介
- [正则增强 (beilu-regex)](regex.md) — 正则脚本引擎
- [变量系统 (beilu-mvu)](mvu.md) — 变量读写
- [插件开发](../developer/plugin-dev.md) — 编写自定义插件

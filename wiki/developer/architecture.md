# 系统架构

always-accompany 用 Deno 后端 + 原生前端，通过 parts 体系组织功能模块。

## 技术栈

| 层 | 技术 |
|---|------|
| 运行时 | Deno（Node.js 兼容） |
| 后端框架 | Express |
| 前端 | 原生 HTML/CSS/JS（无框架） |
| 实时通信 | WebSocket |
| 数据存储 | JSON 文件系统（无数据库） |

## 目录结构

```
beilu-always-accompany/
├── src/
│   ├── server/              ← 服务器核心（启动/路由/中间件）
│   ├── scripts/             ← 共用脚本工具
│   ├── public/
│   │   └── parts/
│   │       ├── shells/      ← 壳（UI + 端点）
│   │       │   └── beilu-chat/  ← 主壳
│   │       ├── plugins/     ← 插件
│   │       └── serviceGenerators/ ← AI 服务生成器
│   └── yonban/              ← 核心功能库（迁移后的实现体）
│       └── core/
│           ├── functions/   ← 通用无状态功能
│           │   ├── api/     ← AI API 调用（6 家 provider）
│           │   ├── prompt/  ← 预设引擎 + 宏 + 变量
│           │   ├── memory/  ← 记忆系统
│           │   ├── security/ ← 安全体系
│           │   ├── screenshot/ ← 截图感知
│           │   ├── web/     ← 联网搜索
│           │   ├── regex/   ← 正则引擎
│           │   └── ...
│           ├── pipelines/   ← 管线运行时
│           └── transport/   ← IDE 桥接
├── data/                    ← 用户数据（运行时生成）
│   ├── config.json          ← 全局配置
│   └── users/               ← 用户数据（per-user 隔离）
│       └── <username>/
│           ├── shells/chat/ ← 对话数据
│           ├── presets/     ← 预设文件
│           └── ...
└── desktop-eye/             ← 桌宠 Electron + Python 截图
```

## Parts 体系

### 三类 Part

| 类型 | 目录 | 说明 |
|------|------|------|
| Shell（壳） | parts/shells/ | 提供 UI + HTTP 端点，系统的"外壳" |
| Plugin（插件） | parts/plugins/ | 功能扩展，通过标准接口参与消息管线 |
| Service Generator（服务生成器） | parts/serviceGenerators/ | AI API 调用实现 |

<div class="wiki-grid wiki-grid-3">
  <div class="wiki-card">
    <div class="wiki-card-title" style="color: var(--beilu-amber-fg);">Shell（壳）</div>
    <div class="wiki-card-desc">提供 UI 界面和 HTTP 端点。系统的"外壳"，用户直接交互的入口。</div>
    <div style="margin-top:6px;"><span class="wiki-badge">parts/shells/</span></div>
  </div>
  <div class="wiki-card">
    <div class="wiki-card-title" style="color: oklch(0.65 0.15 300);">Plugin（插件）</div>
    <div class="wiki-card-desc">功能扩展模块，通过 GetPrompt / TweakPrompt / ReplyHandler 等标准接口参与消息管线。</div>
    <div style="margin-top:6px;"><span class="wiki-badge">parts/plugins/</span></div>
  </div>
  <div class="wiki-card">
    <div class="wiki-card-title" style="color: oklch(0.65 0.15 150);">Service Generator（服务生成器）</div>
    <div class="wiki-card-desc">AI API 调用的具体实现，封装各家 provider 的请求/响应差异。</div>
    <div style="margin-top:6px;"><span class="wiki-badge">parts/serviceGenerators/</span></div>
  </div>
</div>

### 加载机制

`parts_loader.mjs` 负责发现和加载所有 Part：

- 按目录约定扫描 `beilu-part.json` / `info.json`
- 加载各 Part 的 `main.mjs`（入口文件）
- 提取 interfaces 对象，注册各类接口（GetPrompt / TweakPrompt / ReplyHandler 等）

### 薄壳 re-export 范式

yonban 迁移后，许多插件的 `main.mjs` 变成了薄壳——只做 re-export，实际代码在 `yonban/core/functions/` 中。薄壳永不删除（P 型薄壳），因为 parts_loader 按约定位置发现和加载。

## yonban 层

yonban 是 always-accompany 的核心功能库层。与 parts 的区别：

- **parts**：遵循 always-accompany 插件协议，有 info.json 和 interfaces
- **yonban**：纯功能模块，被 parts 和服务器核心引用

### 迁移背景

原先所有代码在 parts 目录中。yonban 迁移将「通用无状态后端功能」集中到 `core/functions/<组>/`，使代码组织更清晰、可复用性更高。

## 数据层

always-accompany 使用 JSON 文件而非数据库。JSON 写入通常采用 tmp + rename，以降低单个文件出现半写入的风险；这不是跨文件或跨模块事务，也不能替代备份和错误检查。

### per-user 数据隔离

在 `data/users/<username>/` 下，每个用户有独立的数据目录。关键数据路径通过 `getUserDataDir(username)` 权威函数获取。

### 数据文件

| 文件 | 说明 |
|------|------|
| config.json | 全局配置（Owner/密钥/用户列表） |
| users/\<user\>/shells/chat/\<chatid\>.json | 对话数据 |
| users/\<user\>/presets/config.json | 预设配置 |
| users/\<user\>/presets/registry.json | 预设注册表 |
| users/\<user\>/presets/\*.json | 预设文件 |

## 模块间依赖原则

- **安全模块**（path_confine / auth / security_policy）处于依赖最底层，不引用上层模块
- **parts_loader** 在 server 域，被 endpoints / requestBuilder 引用
- **插件之间** 通过 extension 字段传递数据（间接通信），不直接 import
- **循环依赖** 通过惰性动态 import 打破

<div class="wiki-layers">
  <div class="wiki-layer wiki-layer-amber">
    <span class="wiki-layer-label">Shell 层</span>
    UI + 端点 — 用户请求入口，调用下层服务
  </div>
  <div class="wiki-layer wiki-layer-purple">
    <span class="wiki-layer-label">Plugin 层</span>
    功能扩展 — 通过 extension 间接通信，不互相 import
  </div>
  <div class="wiki-layer wiki-layer-blue">
    <span class="wiki-layer-label">Server 层</span>
    parts_loader / endpoints / requestBuilder — 加载与调度
  </div>
  <div class="wiki-layer wiki-layer-green">
    <span class="wiki-layer-label">yonban 层</span>
    核心功能库 — 纯函数模块，被上层引用
  </div>
  <div class="wiki-layer">
    <span class="wiki-layer-label">安全层</span>
    path_confine / auth / security_policy — 最底层，不引用上层
  </div>
</div>

## 导航

- [消息管线](message-pipeline.md) — 消息流转全链路
- [插件开发](plugin-dev.md) — 编写自定义插件
- [API 端点参考](api-reference.md) — HTTP/WS 接口
- [安全中心](../security/overview.md)（[打开面板](beilu:settings/security)） — 安全架构

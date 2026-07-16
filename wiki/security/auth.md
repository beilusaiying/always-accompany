# 权限与鉴权

always-accompany 的认证系统（auth.mjs）覆盖 JWT、API Key、用户 CRUD 和暴力破解防御。

## 认证体系

always-accompany 的认证系统（auth.mjs）涵盖五个核心职责域：

1. JWT 签发 / 验证 / 刷新 / 撤销
2. 认证中间件（路由保护）
3. API Key 管理与 scope 体系
4. 用户 CRUD（注册/登录/改名/删号/改密/安全问题密码找回）
5. 暴力破解防御

## 初始化流程

服务器启动时，`initAuth()` 完成以下初始化：

- ES256 密钥对加载（用于 JWT 签名验证）
- Argon2 预热（密码哈希算法，优先 Rust FFI 实现，不可用回退纯 JS）
- 用户数据清洗

## 认证路径

请求到达受保护端点时，`try_auth_request` 按优先级尝试四条认证路径：

| 优先级 | 认证方式 | 来源 | 说明 |
|--------|---------|------|------|
| 1 | API Key | `x-api-key` header | 查 SHA256 哈希表验证 |
| 2 | API Access Token | `cookies.apiAccessToken` | JWT api 类型（透传 scopes，防洗白） |
| 3 | Access Token | `cookies.accessToken` | JWT 标准验证（本人会话，scope=['*']） |
| 4 | Refresh Token | `cookies.refreshToken` | 刷新令牌续签（轮换 + 持久化防重启丢失） |

先命中即返回，不继续尝试后续路径。

## 中间件

### authenticate

标准认证中间件。未认证请求返回 401。所有需要登录的端点都使用此中间件。

### requireOwner

Owner 权限中间件。非 owner 用户返回 403。用于安全策略突变端点（如修改安全敏感配置）。

### auth_request

内部认证请求函数，供非 Express 路由的场景使用（如 API v1 路由）。

## Owner 体系

### 实例 Owner

首个注册的用户自动成为实例 owner（持久化在 `config.ownerUsername`）。Owner 拥有最高权限：

- 修改安全策略（部署模式、安全敏感配置）
- 管理其他用户账户
- 访问所有 owner-only 端点

### 本地单用户

本地部署时，唯一用户即 owner，所有 owner 权限自然获得。

## JWT 实现

### 签名算法

使用 ES256（ECDSA P-256）算法。密钥对在首次启动时自动生成并持久化。私钥不存入 config.json（安全隔离），由模块变量持有。

### Token 有效期

| Token 类型 | 有效期 |
|-----------|--------|
| Access Token | 1 天 |
| Refresh Token | 30 天 |

### Token 刷新

Refresh Token 支持轮换机制：每次使用 Refresh Token 续签时，旧 Token 失效，签发新 Token。Refresh Token 持久化到磁盘，防止服务重启导致用户被踢出。

### Token 缓存

JWT 验证结果缓存在内存中（最近 32 条），减少重复验证的密码学开销。

## API Key

### 管理

Owner 可以创建 API Key，每个 Key 绑定特定的 scope（权限范围）。Key 以 SHA256 哈希形式存储，明文仅在创建时展示一次。

### SEC-T6 Scope 体系

API Key 的 scope 决定了可以访问的端点范围。通过 `requireApiKeyScope` 中间件进行端点级的 scope 检查，防止低权限 Key 访问高权限功能。

API Access Token（由 API Key 签发的 JWT）会透传 scopes 字段，防止 scope 洗白（通过 JWT 续签时保留原始 scopes）。

## 暴力破解防御

### 账户锁定

连续 5 次登录失败后，账户锁定 10 分钟。

### 蜜罐机制

当暴力破解尝试超过阈值（8 次），系统有概率（1/3）返回"假成功"响应。这使攻击者无法区分真实密码和假成功，增加破解难度。

### 时间攻击保护

登录验证使用恒定时间比较，防止通过响应时间差异推断密码正确性。

## 密码存储

用户密码使用 Argon2id 哈希存储。优先使用 `@node-rs/argon2`（Rust FFI 实现，性能更优），不可用时回退到纯 JavaScript 实现。

## 安全事件

auth 模块在用户生命周期事件中触发以下事件，供其他模块监听：

| 事件 | 时机 |
|------|------|
| BeforeUserDeleted | 删除用户前 |
| AfterUserDeleted | 删除用户后 |
| AfterUserRenamed | 用户改名后 |

## Cookie 安全

Cookie 选项根据连接类型动态设置：

- HTTPS 连接：设置 `Secure` 标志（按请求协议动态判断）
- 始终设置 `HttpOnly`（JavaScript 无法读取）
- 设置 `SameSite=Lax`（限制跨站携带，兼顾顶层导航）

## 导航

- [安全中心](overview.md) — 安全体系总览
- [系统架构](../developer/architecture.md) — 整体架构
- [API 端点参考](../developer/api-reference.md) — 端点认证要求

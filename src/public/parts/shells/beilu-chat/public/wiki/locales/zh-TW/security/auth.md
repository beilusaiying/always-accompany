# 權限與鑑權

always-accompany 的認證系統（auth.mjs）涵蓋 JWT、API Key、使用者 CRUD 和暴力破解防禦。

## 認證體系

always-accompany 的認證系統（auth.mjs）涵蓋五個核心職責域：

1. JWT 簽發 / 驗證 / 重新整理 / 撤銷
2. 認證中介層（路由保護）
3. API Key 管理與 scope 體系
4. 使用者 CRUD（註冊/登入/改名/刪號/改密/安全問題密碼找回）
5. 暴力破解防禦

## 初始化流程

伺服器啟動時，`initAuth()` 完成以下初始化：

- ES256 金鑰對載入（用於 JWT 簽名驗證）
- Argon2 預熱（密碼雜湊演算法，優先 Rust FFI 實作，不可用回退純 JS）
- 使用者資料清洗

## 認證路徑

請求到達受保護端點時，`try_auth_request` 按優先順序嘗試四條認證路徑：

| 優先順序 | 認證方式 | 來源 | 說明 |
|--------|---------|------|------|
| 1 | API Key | `x-api-key` header | 查 SHA256 雜湊表驗證 |
| 2 | API Access Token | `cookies.apiAccessToken` | JWT api 類型（透傳 scopes，防洗白） |
| 3 | Access Token | `cookies.accessToken` | JWT 標準驗證（本人會話，scope=['*']） |
| 4 | Refresh Token | `cookies.refreshToken` | 重新整理令牌續簽（輪換 + 持久化防重啟遺失） |

先命中即回傳，不繼續嘗試後續路徑。

## 中介層

### authenticate

標準認證中介層。未認證請求回傳 401。所有需要登入的端點都使用此中介層。

### requireOwner

Owner 權限中介層。非 owner 使用者回傳 403。用於安全策略突變端點（如修改安全敏感設定）。

### auth_request

內部認證請求函式，供非 Express 路由的情境使用（如 API v1 路由）。

## Owner 體系

### 執行個體 Owner

首個註冊的使用者自動成為執行個體 owner（持久化在 `config.ownerUsername`）。Owner 擁有最高權限：

- 修改安全策略（部署模式、安全敏感設定）
- 管理其他使用者帳戶
- 存取所有 owner-only 端點

### 本機單使用者

本機部署時，唯一使用者即 owner，所有 owner 權限自然取得。

## JWT 實作

### 簽名演算法

使用 ES256（ECDSA P-256）演算法。金鑰對在首次啟動時自動產生並持久化。私鑰不存入 config.json（安全隔離），由模組變數持有。

### Token 有效期

| Token 類型 | 有效期 |
|-----------|--------|
| Access Token | 1 天 |
| Refresh Token | 30 天 |

### Token 重新整理

Refresh Token 支援輪換機制：每次使用 Refresh Token 續簽時，舊 Token 失效，簽發新 Token。Refresh Token 持久化到磁碟，防止服務重啟導致使用者被踢出。

### Token 快取

JWT 驗證結果快取在記憶體中（最近 32 條），減少重複驗證的密碼學開銷。

## API Key

### 管理

Owner 可以建立 API Key，每個 Key 繫結特定的 scope（權限範圍）。Key 以 SHA256 雜湊形式儲存，明文僅在建立時展示一次。

### SEC-T6 Scope 體系

API Key 的 scope 決定了可以存取的端點範圍。透過 `requireApiKeyScope` 中介層進行端點級的 scope 檢查，防止低權限 Key 存取高權限功能。

API Access Token（由 API Key 簽發的 JWT）會透傳 scopes 欄位，防止 scope 洗白（透過 JWT 續簽時保留原始 scopes）。

## 暴力破解防禦

### 帳戶鎖定

連續 5 次登入失敗後，帳戶鎖定 10 分鐘。

### 蜜罐機制

當暴力破解嘗試超過閾值（8 次），系統有機率（1/3）回傳「假成功」回應。這使攻擊者無法區分真實密碼和假成功，增加破解難度。

### 時間攻擊保護

登入驗證使用恆定時間比較，防止透過回應時間差異推斷密碼正確性。

## 密碼儲存

使用者密碼使用 Argon2id 雜湊儲存。優先使用 `@node-rs/argon2`（Rust FFI 實作，效能更優），不可用時回退到純 JavaScript 實作。

## 安全事件

auth 模組在使用者生命週期事件中觸發以下事件，供其他模組監聽：

| 事件 | 時機 |
|------|------|
| BeforeUserDeleted | 刪除使用者前 |
| AfterUserDeleted | 刪除使用者後 |
| AfterUserRenamed | 使用者改名後 |

## Cookie 安全

Cookie 選項根據連接類型動態設定：

- HTTPS 連接：設定 `Secure` 旗標（按請求協定動態判斷）
- 始終設定 `HttpOnly`（JavaScript 無法讀取）
- 設定 `SameSite=Lax`（限制跨站攜帶，兼顧頂層導覽）

## 導覽

- [安全中心](overview.md) — 安全體系總覽
- [系統架構](../developer/architecture.md) — 整體架構
- [API 端點參考](../developer/api-reference.md) — 端點認證要求

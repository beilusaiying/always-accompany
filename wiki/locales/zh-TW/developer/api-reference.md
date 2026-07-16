# API 端點參考

beilu-chat 的所有 HTTP/WS 路由在 `endpoints.mjs` 中定義。本文件列出主要端點及其功能。所有端點都透過 `authenticate` 中介軟體保護（需要登入）。詳見[權限與鑑權](../security/auth.md)。

## 路由前綴

所有 beilu-chat 端點的基礎路徑為 `/api/shells/chat/`。以下端點省略此前綴。

## 對話訊息操作

以 `:chatid` 為路徑參數的端點，經過 `router.param("chatid")` 中央歸屬校驗——驗證請求使用者是否有權操作該對話。

| 方法 | 路徑 | 說明 |
|------|------|------|
| WS | `/ws/.../ui/:chatid` | 聊天 UI WebSocket 連接 |
| GET | `:chatid/initial-data` | 開啟對話時取得初始化資料 |
| GET | `:chatid/log` | 取得 chatLog（支援分頁） |
| GET | `:chatid/log/length` | chatLog 長度（`?visible=1` 僅未隱藏條目） |
| POST | `:chatid/message` | 使用者傳送訊息（R1 入口，觸發 AI 回覆） |
| PUT | `:chatid/message/:index` | 編輯指定訊息 |
| DELETE | `:chatid/message/:index` | 刪除指定訊息 |
| POST | `:chatid/trigger-reply` | 僅觸發 AI 回覆（不儲存使用者訊息） |
| POST | `:chatid/messages/delete-range` | 批次刪除訊息範圍 |
| POST | `:chatid/messages/hide` | 隱藏/取消隱藏訊息範圍 |
| PUT | `:chatid/timeline` | 切換時間線（greeting swipe） |
| GET | `:chatid/render/entries` | regex 觸發修復：render 查詢 |

## 對話生命週期

| 方法 | 路徑 | 說明 |
|------|------|------|
| POST | `new` | 新建空對話 |
| DELETE | `delete` | 批次刪除對話 |
| POST | `:chatid/rename` | 對話改名 |
| POST | `:chatid/mode` | 設定對話模式徽標 |
| POST | `:chatid/using` | 模式視窗在用指標（mode:char -> chatid） |
| POST | `branch` | 對話分叉 |
| GET | `getchatlist` | 取得聊天清單 |
| POST | `search` | 全文搜尋聊天內容 |

## 對話中繼資料

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `:chatid/chars` | 對話內角色清單 |
| GET | `:chatid/plugins` | 對話內外掛清單 |
| GET | `:chatid/persona` | 目前人設名 |
| GET | `:chatid/world` | 目前世界設定名 |
| POST | `:chatid/char` | 新增角色到對話 |

## 角色卡管理

| 方法 | 路徑 | 說明 |
|------|------|------|
| POST | `create-char` | 建立空白角色卡 |
| PUT | `update-char/:charName` | 更新角色卡欄位 |
| DELETE | `delete-char/:charName` | 刪除角色卡（8 步清理） |
| POST | `import-char` | 匯入角色卡 JSON/PNG（含正規表示式 + 世界書遷移） |
| GET | `char/:charName/export` | 匯出角色卡 PNG/JSON |
| GET | `char-data/:charName` | 取得 chardata.json |
| GET | `char-aisource/:charName` | 取得角色繫結 AI 源 + 可用源清單 |

## 人設管理

| 方法 | 路徑 | 說明 |
|------|------|------|
| POST | `persona/create` | 建立人設 |
| DELETE | `persona/:name` | 刪除人設 |
| PUT | `persona/:name/update` | 更新人設描述 + 頭像 |

## IDE 橋接

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `ide/wstoken` | 瀏覽器代讀 IDE WS token |
| POST | `ide/connect` | 強制後端 ideClient 立即連接 |
| POST | `ide/manual-tool-call` | 人工面板工具呼叫（走後端統一執行閘） |

## 多組並行管理

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `groups` | 列出本使用者全部組 |
| POST | `groups` | 新建組 |
| PUT | `groups/:groupId` | 更新組欄位 |
| DELETE | `groups/:groupId` | 刪組（含終止 worker） |
| POST | `groups/:groupId/role` | 繫結組內角色到 chatid |
| DELETE | `groups/:groupId/role/:role` | 解繫組內角色 |
| GET | `groups/engine` | 並行引擎開關狀態 |
| POST | `groups/engine` | 切換並行引擎開關 |
| POST | `groups/:groupId/execute` | 啟動組內全部角色對話 |

## 外掛設定端點

外掛設定透過 parts_router 的統一端點存取（非 beilu-chat 特有）：

| 操作 | 端點 | 說明 |
|------|------|------|
| 讀設定 | `GET /api/parts/:partpath/config` | 取得外掛設定 |
| 寫設定 | `POST /api/parts/:partpath/config` | 更新外掛設定 |
| 讀資料 | `GET /api/parts/:partpath/data` | 呼叫 GetData |
| 寫資料 | `POST /api/parts/:partpath/data` | 呼叫 SetData |

安全敏感的 config/setdata 寫入經 `partConfigWriteNeedsOwner` 偵測，命中時要求 owner 權限。

## WebSocket 事件

always-accompany 透過 WebSocket 實作即時通訊。主要事件：

### 伺服端 -> 用戶端

| 事件 | 說明 |
|------|------|
| `message_added` | 新訊息新增（使用者訊息 / AI 回覆佔位） |
| `message_replaced` | 訊息被替換（AI 回覆落定 / 隱藏範圍更新） |
| `message_edited` | 訊息被編輯 |
| `message_deleted` | 訊息被刪除 |
| `stream_start` | AI 串流回覆開始 |
| `stream_update` | AI 串流回覆新片段 |
| `token_usage` | Token 使用統計 |
| `typing_status` | 輸入狀態（多組並行時的對端活動指示） |
| `auto_continue_fuse` | 自動續輪熔斷通知 |

### 用戶端 -> 伺服端

| 事件 | 說明 |
|------|------|
| `stop_generation` | 停止目前產生 |

## 認證要求

| 端點類型 | 認證級別 |
|---------|---------|
| 所有 API 端點 | authenticate（需登入） |
| 安全敏感設定 | requireOwner（需實例 owner） |
| API v1 外部呼叫 | API Key + scope 校驗 |

## 錯誤回應

| 狀態碼 | 說明 |
|--------|------|
| 401 | 未認證（未登入或 token 過期） |
| 403 | 無權限（非 owner / 對話不屬於目前使用者） |
| 404 | 對話 / 角色 / 資源不存在 |
| 500 | 伺服器內部錯誤 |

## 導覽

- [系統架構](architecture.md) — 整體架構
- [訊息管線](message-pipeline.md) — 訊息流轉
- [權限與鑑權](../security/auth.md) — 認證體系
- [外掛開發](plugin-dev.md) — 自訂外掛

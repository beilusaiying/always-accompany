# INJ規則設定

各條 INJ 規則的欄位定義、門控邏輯和互斥關係。

## INJ 規則欄位說明

每條 INJ 規則由以下欄位定義：

| 欄位 | 類型 | 說明 |
|------|------|------|
| **name** | 字串 | 規則名稱標識（如 INJ-1-chat） |
| **content** | 字串 | 注入的內容範本，支援 `{{macro}}` 巨集替換 |
| **autoMode** | 列舉 | 門控模式：chat/code/work/bot/always/all/manual/file（另可為自訂模式的域名） |
| **depth** | 數字 | 注入深度：999=系統級, 0=最新訊息後, N=第N輪前 |
| **role** | 列舉 | 訊息角色：system/user/assistant |
| **enabled** | 布林 | 是否啟用 |

## 預設 INJ 規則詳解

### INJ-1-chat

- **autoMode**: `chat`
- **depth**: `999`（系統提示級）
- **role**: `system`
- **功能**: 向 AI 說明 chat 模式下的記憶表格系統。內容包括 #0-#9 各表的名稱、儲存內容、寫入格式，以及 `<tableEdit>` 標籤的語法說明。

**運行鏈**: 使用者處於 chat 模式 → autoMode 比對 → INJ-1-chat 的 content 作為 system 訊息注入到上下文最前端（depth 999）→ AI 知道如何使用記憶表格。

### INJ-1-write-code

- **autoMode**: `code`
- **depth**: `999`
- **role**: `system`
- **功能**: 向 AI 說明 code 模式下的記憶表格系統。內容包括 C0-C5 各表的名稱、儲存內容、寫入格式。

### INJ-1-work

- **autoMode**: `work`
- **depth**: `999`
- **role**: `system`
- **功能**: 向 AI 說明 work 模式下的記憶表格系統。內容包括 W0-W4 各表的名稱、儲存內容、寫入格式。

### INJ-2

- **autoMode**: `file`（由檔案層設定決定）
- **depth**: 可設定
- **role**: `system`
- **功能**: 注入來自角色檔案或預設集的額外 AI 提示詞。這些提示詞可能包含角色專屬的行為指導、寫作風格要求等。

**互斥**: 當 IDE 連接時，系統使用 INJ-2-code 變體替代 INJ-2。兩者不會同時生效。

### INJ-3

- **autoMode**: `bot`
- **depth**: 可設定
- **role**: `system`
- **功能**: 注入 Bot 平台（如 Telegram、Discord）的專用提示詞。包括平台特定的互動規則、訊息格式限制等。

## autoMode 門控邏輯

```
收到訊息，確定目前環境
    ↓
遍歷所有 INJ 規則
    ↓
對每條規則檢查 autoMode：
  chat   → 目前是 chat 模式？（含 airp 別名域）
  code   → 目前是 code 模式？
  work   → 目前是 work 模式？
  bot    → 目前是 Bot 平台接入？
  always / all → 直接通過（全模式）
  manual → 開啟即生效
  file   → 目前是否檔案/IDE 模式
    ↓
通過門控的 INJ 進入注入佇列
    ↓
檢查互斥關係，有衝突的只保留一條
    ↓
執行巨集替換 → 按 depth 排序 → 注入上下文
```

## depth 與上下文位置

depth 值決定注入在上下文中的物理位置。理解 depth 需要先理解上下文的結構：

```
[depth 999] 系統提示區域
  ├─ 角色設定
  ├─ INJ-1 表格說明（depth 999）
  └─ 其他系統級 INJ
    ...
[depth N] 聊天歷史區域
  ├─ 第 N 輪對話
  ├─ ...（世界書 atDepth 條目在此插入）
  ├─ 第 2 輪對話
  ├─ 第 1 輪對話
[depth 0] 最新訊息區域
  └─ 使用者的最新訊息
```

depth 值越大越靠前（系統級），越小越靠近最新訊息。

## 互斥規則詳解

### INJ-1 系列互斥

三條 INJ-1（chat / write-code / work）透過 autoMode 自然互斥——同一時刻只有一種工作模式，因此只有一條 INJ-1 的 autoMode 會比對。

### INJ-2 vs INJ-2-code

INJ-2 和 INJ-2-code 是同一位置的兩個變體：

- **INJ-2**：標準檔案層提示詞，適用於普通對話情境
- **INJ-2-code**：IDE 連接時的檔案層提示詞，可能包含程式碼相關的額外指導

切換邏輯：系統偵測到 IDE 連接 → 使用 INJ-2-code；未連接 → 使用 INJ-2。

## 巨集替換詳解

巨集在 INJ content 中以 `{{巨集名}}` 格式書寫，注入時被替換為實際值。

**常用巨集分類**：

| 類別 | 巨集範例 | 說明 |
|------|--------|------|
| 角色資訊 | `{{char}}`、`{{charName}}` | 目前角色名稱 |
| 使用者資訊 | `{{user}}`、`{{userName}}` | 目前使用者名稱 |
| 時間資訊 | `{{time}}`、`{{date}}`、`{{weekday}}` | 目前時間日期 |
| 系統資訊 | `{{model}}`、`{{maxTokens}}` | 目前模型和設定 |
| 記憶資訊 | `{{tableContent_N}}`、`{{memoryCount}}` | 記憶表格相關 |

巨集替換的完整清單約 30 種，具體請參考巨集系統文件。

## 自訂 INJ 規則

除了內建的多條 INJ，系統支援新增自訂規則。自訂規則需要指定：

1. 唯一的 name 標識
2. content 內容（支援巨集）
3. autoMode 門控條件
4. depth 注入位置
5. role 訊息角色

自訂規則與預設規則遵循相同的門控和注入邏輯。

## 除錯建議

- 檢查 INJ 是否生效：確認 autoMode 與目前模式比對、enabled 為 true
- 檢查注入位置：確認 depth 值是否符合預期
- 檢查巨集替換：確認 `{{macro}}` 是否被正確替換（拼寫錯誤的巨集不會被替換，會原樣保留）
- 檢查互斥衝突：如果預期的 INJ 沒有生效，檢查是否被互斥規則排除

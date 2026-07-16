# 外掛開發

always-accompany 的外掛系統允許你編寫自訂外掛來擴充功能。外掛透過標準化的介面參與[訊息管線](message-pipeline.md)，可以向 AI 注入提示詞、處理 AI 回覆、提供設定面板等。

## 外掛結構

一個 always-accompany 外掛的最小目錄結構：

```
plugins/my-plugin/
├── info.json          ← 外掛中繼資料（必需）
├── main.mjs           ← 外掛入口（必需）
└── (可選) display.mjs ← 前端設定面板
```

### info.json

外掛的中繼資料檔案，由 parts_loader 發現和讀取：

```json
{
  "id": "my-plugin",
  "name": "我的外掛",
  "description": "外掛功能描述",
  "version": "1.0.0"
}
```

或使用 `beilu-part.json` 格式（兩者均被 parts_loader 識別）。

### main.mjs

外掛入口檔案。匯出一個包含 interfaces 的物件：

```javascript
export default {
  info: { /* 外掛資訊 */ },
  interfaces: {
    chat: {
      GetPrompt,     // 注入提示詞
      TweakPrompt,   // 調整提示詞
      ReplyHandler,  // 處理 AI 回覆
    },
    config: {
      GetData,       // 讀取設定
      SetData,       // 寫入設定
    },
  },
};
```

## 介面詳解

### GetPrompt

在訊息傳送前呼叫，回傳外掛要注入到提示詞中的內容。

**參數**：`(chatReplyRequest)`

**回傳值**：`single_part_prompt_t` 物件，包含：

```javascript
{
  text: [
    { content: "提示詞文字", important: 0 }
  ],
  extension: {
    // 外掛間傳遞的資料（不直接傳給 AI）
  }
}
```

- `text[]`：要注入到提示詞中的文字片段，按 important 排序
- `extension`：擴充資料，供其他外掛在 TweakPrompt 階段讀取

### TweakPrompt

在所有 GetPrompt 之後呼叫，允許修改已組裝的 prompt_struct。執行三輪：

**參數**：`(prompt_struct, chatReplyRequest, detail_level)`

- `prompt_struct`：目前的提示詞結構（可直接修改）
- `detail_level`：目前輪次（2 -> 1 -> 0）

**回傳值**：無（直接修改 prompt_struct）

典型用法：
- Round 1 (dl=2)：讀取其他外掛的 extension 資料
- Round 2 (dl=1)：重新組織訊息序列
- Round 3 (dl=0)：最終調整

### ReplyHandler

AI 回覆到達後呼叫，用於解析和處理回覆中的特定標籤。

**參數**：`(replyText, chatReplyRequest)`

**回傳值**：處理後的文字（可修改回覆內容）

典型用法：
- 解析 AI 回覆中的自訂標籤
- 執行標籤對應的操作（檔案讀寫、變數設定等）
- 將操作結果透過 GetPrompt 注入到下一輪

### GetData

前端或其他模組讀取外掛設定/狀態時呼叫。

**參數**：`(request)`

**回傳值**：設定資料物件

### SetData

前端或其他模組寫入外掛設定或觸發動作時呼叫。

**參數**：`(data, request)`

`data` 中的 `_action` 欄位可用於區分不同操作類型。

## 外掛間通訊

外掛之間不直接 import，而是透過 `prompt_struct` 的 `extension` 欄位間接通訊：

1. 外掛 A 在 GetPrompt 階段將資料寫入 `extension.my_data`
2. 外掛 B 在 TweakPrompt 階段從 `prompt_struct.plugin_prompts['plugin-a'].extension.my_data` 讀取

這種鬆耦合設計確保外掛可以獨立開發和部署。

## 外掛載入

### 自動載入

在 `defaultParts.plugins` 中列出的外掛會在每次對話中自動載入。

### 載入時序

parts_loader 在伺服器啟動時按目錄順序載入外掛。外掛的模組級程式碼會在載入時執行，注意避免阻塞和循環相依。

如需引用其他模組，推薦使用惰性動態 import（首次使用時載入），避免載入時序問題。

## 安全注意事項

### 安全敏感設定

如果你的外掛有安全敏感的設定項（如開關沙箱、允許執行命令等），需要在 `security_policy.mjs` 的 `OWNER_ONLY_PART_CONFIG_WRITE` 表中註冊，確保這些設定只能由 owner 修改。

### 使用者資料隔離

在多使用者情境下，外掛的設定和資料應按使用者隔離。推薦使用 `getUserDataDir(username)` 取得使用者資料路徑，或使用 AsyncLocalStorage 實作 per-user 上下文。

### 前端設定面板

透過 `GetConfigDisplayContent` 介面回傳前端設定面板的 JavaScript 程式碼。面板在瀏覽器中執行，注意不要暴露敏感資訊。

## 使用者外掛 (beilu-plugin-host)

透過 beilu-plugin-host，使用者可以在執行階段載入自訂外掛腳本，無需重啟服務。使用者外掛與內建外掛享有相同的介面能力，但受安全策略約束。

## 測試

外掛開發時建議：

- 使用 `BEILU_DIAG=<模組名>` 環境變數開啟診斷日誌
- 透過 whitebox 追蹤系統（wbTrace / wbDetect）記錄關鍵事件
- 使用 fakeSend（token 預覽）模式測試 GetPrompt / TweakPrompt 輸出

## 導覽

- [外掛概覽](../plugins/overview.md) — 現有外掛清單
- [訊息管線](message-pipeline.md) — 外掛在管線中的位置
- [系統架構](architecture.md) — 整體架構
- [API 端點參考](api-reference.md) — 端點介面

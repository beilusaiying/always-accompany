# 訊息管線

訊息管線是 always-accompany 中從使用者傳送訊息到 AI 回覆顯示的完整資料流。理解這條鏈路是理解 always-accompany 運作原理的關鍵。

## 全鏈路概覽

<div class="wiki-flow">
  <div class="wiki-box wiki-box-amber wiki-box-full"><b>使用者在前端傳送訊息</b></div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-blue wiki-box-full"><b>POST /:chatid/message</b><small>endpoints.mjs</small></div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-blue wiki-box-full"><b>addUserReply</b><small>chatOps.mjs — 儲存使用者訊息到 chatLog</small></div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-green wiki-box-full"><b>triggerCharReply</b><small>generation.mjs — 觸發 AI 回覆</small></div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-green wiki-box-full"><b>getChatRequest</b><small>requestBuilder.mjs — 建構請求物件</small></div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-green wiki-box-full"><b>buildPromptStruct</b><small>組裝提示詞結構</small></div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-group" style="width:100%;max-width:480px;">
    <div class="wiki-group-title">外掛參與階段</div>
    <div class="wiki-flow" style="margin:0;">
      <div class="wiki-box wiki-box-purple wiki-box-full"><b>各外掛 GetPrompt</b><small>並行收集提示詞片段</small></div>
      <div class="wiki-arrow">↓</div>
      <div class="wiki-box wiki-box-purple wiki-box-full"><b>各外掛 TweakPrompt × 3 輪</b><small>調整提示詞結構</small></div>
    </div>
  </div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-green wiki-box-full"><b>executeGeneration</b><small>generation.mjs</small></div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-green wiki-box-full"><b>GetReply → StructCall</b><small>provider — 呼叫 AI API</small></div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-green wiki-box-full"><b>AI 串流回應</b><small>StreamManager 逐 chunk 推送</small></div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-purple wiki-box-full"><b>各外掛 ReplyHandler</b><small>解析回覆中的操作標籤</small></div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-blue wiki-box-full"><b>finalizeEntry</b><small>建構訊息條目</small></div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-blue wiki-box-full"><b>addChatLogEntry</b><small>chatOps.mjs — 儲存 AI 回覆到 chatLog</small></div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-red wiki-box-full"><b>broadcastChatEvent</b><small>WS 推送給前端</small></div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-red wiki-box-full"><b>自動續輪決策</b><small>是否繼續產生</small></div>
</div>

## 各階段詳解

### 1. 使用者傳送訊息

前端透過 `POST /:chatid/message` 端點傳送使用者訊息。端點經過 `router.param("chatid")` 歸屬校驗後，交給 chatOps 處理。

### 2. 儲存使用者訊息

`addUserReply` 將使用者訊息建構為 `chatLogEntry_t`，push 到 chatLog 陣列，儲存到磁碟，並透過 WS 廣播 `message_added` 事件通知前端。

### 3. 建構請求物件

`getChatRequest` 負責組裝完整的 `chatReplyRequest_t` 物件：

- 載入對話中繼資料（chatMetadata）
- 解析使用者和角色資訊
- 合併預設外掛（getAllDefaultParts 的外掛即使不在舊聊天的 timeSlice 中也會參與）
- 取得可見聊天日誌（getVisibleChatLog）

### 4. 組裝提示詞結構

`buildPromptStruct` 呼叫管線執行階段（yonban pipelines），觸發所有 Part 的 GetPrompt 和 TweakPrompt：

#### GetPrompt 階段

每個外掛回傳自己要注入到提示詞中的文字片段。回傳值進入 `prompt_struct` 的對應區域：

- `char_prompt` — 角色相關提示
- `user_prompt` — 使用者相關提示
- `world_prompt` — 世界/環境相關提示
- `plugin_prompts` — 外掛提示（按外掛名分區）

beilu-preset 的 GetPrompt 回傳空殼（預設集的真正工作在 TweakPrompt 階段）。

#### TweakPrompt 三輪

所有外掛的 TweakPrompt 按 detail_level 遞減執行三輪：

| 輪次 | dl 值 | 核心動作 |
|------|-------|---------|
| Round 1 | 2 | 收集清空 — 讀取各模組提示詞到巨集環境 env，清空原始模組 |
| Round 2 | 1 | 重建訊息 — 引擎 buildAllEntries() 產出四段訊息，合併 model_params |
| Round 3 | 0 | 快照 — 記錄除錯快照（commanderSnapshot），不再改 chat_log |

### 5. AI API 呼叫

`executeGeneration` 是串流產生核心。它透過 GetReply 介面呼叫 provider 的 StructCall：

- **StructCall** 接收 prompt_struct，呼叫 `assembleCommanderMessages`（司令員模式）或直接拼裝訊息
- **applyModelParams** 將 canonical 參數映射為 provider 特定形狀
- 發起 HTTP/SSE 串流請求，逐 chunk 回傳

### 6. 串流回應處理

StreamManager 管理串流回應：

- 逐 chunk 解析 SSE 資料
- 透過 WS 廣播 `stream_start` / `stream_update` 事件給前端
- 前端逐字顯示 AI 回覆

### 7. ReplyHandler 解析

AI 回覆完成後，各外掛的 ReplyHandler 依次處理：

- **beilu-files**：解析 `<file_op>` / `<tool_call>` 標籤，執行檔案操作
- **beilu-regex**：執行正規表示式替換規則
- **beilu-mvu**：解析變數操作命令
- **beilu-memory**：解析 `<tableEdit>` 標籤，更新記憶表格
- **beilu-web**：解析 `<search>` / `<browse>` 標籤，觸發聯網請求

### 8. 儲存與廣播

`finalizeEntry` 建構最終的 AI 訊息條目（chatLogEntry_t），透過 `addChatLogEntry` 儲存到 chatLog 並廣播。

### 9. 自動續輪

如果 AI 的回覆觸發了續輪條件（如正在執行程式碼任務、工具呼叫後需要繼續），系統自動觸發新一輪的 `triggerCharReply`。

續輪有安全限制：
- 續輪無次數上限，可通過面板開關控制
- 空回覆重試限制（EMPTY_REPLY_MAX_RETRIES = 3）
- fuzzy_edit 連續失敗熔斷（FUZZY_FAIL_LIMIT = 3）
- Loop 自動繼續：AI 無工具調用結束時可注入自訂文字續輪

## 模組職責邊界

| 模組 | 管什麼 | 不管什麼 |
|------|--------|---------|
| endpoints.mjs | HTTP 參數校驗 + 委派 | 不管產生邏輯 |
| requestBuilder.mjs | 請求物件組裝 | 不管產生排程 |
| generation.mjs | 觸發 -> 串流產生 -> 落盤 -> 續輪 | 不管提示詞組裝 |
| chatOps.mjs | 訊息 CRUD + 寫操作 | 不管 AI 產生 |
| chatStorage.mjs | 儲存路徑解析 + 持久化 | 不管訊息操作 |
| prompt_struct.mjs | 提示詞結構定義 + 序列化 | 不管外掛呼叫 |

## RT-4 全域契約

所有改變 chatLog 後需要通知前端的操作，都必須先 `await saveChat`（落盤），再 `broadcastChatEvent`（WS 推送）。如果順序反過來，前端收到 WS 事件後 refetch 端點可能讀到舊資料。

## 導覽

- [系統架構](architecture.md) — 整體架構
- [預設集系統概覽](../presets/overview.md) — 預設集引擎
- [司令員模式](../presets/commander.md) — 五段拼裝
- [外掛概覽](../plugins/overview.md) — 外掛介面

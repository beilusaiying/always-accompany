# 執行鏈路

從 AI 輸出到 IDE 實際執行的完整資料流。理解這條鏈路有助於排查工具呼叫失敗的原因。

## 主鏈路：10 步執行流程

<div class="wiki-flow">
  <div class="wiki-box wiki-box-purple">
    <div class="wiki-label">1. AI 輸出</div>
    AI 在回覆中產生 &lt;ideToolCall&gt; 標籤，包含工具名和參數
  </div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-purple">
    <div class="wiki-label">2. ReplyHandler 解析</div>
    訊息管線的 ReplyHandler 攔截回覆，解析出 ideToolCall 標籤
  </div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-blue">
    <div class="wiki-label">3. 讀寫分流</div>
    判斷工具類型：讀操作直接放行，寫操作進入安全檢查
  </div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-red">
    <div class="wiki-label">4. 安全檢查</div>
    五級安全閘逐級校驗：命令閘 → 規則集 → 審核門 → 統一執行閘 → 指紋繫結
  </div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-amber">
    <div class="wiki-label">5. 審核佇列</div>
    需審核的操作進入佇列，前端彈出審核卡片等待使用者批准或拒絕
  </div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-blue">
    <div class="wiki-label">6. callTool 排程</div>
    審核通過後，callTool 將請求封裝為 WS 訊息發往 YonBan 擴充套件
  </div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-green">
    <div class="wiki-label">7. WebSocket 傳輸</div>
    請求透過 WS 長連接送達本機 IDE 中執行的 YonBan 擴充套件
  </div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-green">
    <div class="wiki-label">8. ToolExecutor 執行</div>
    YonBan 擴充套件的 ToolExecutor 在本機 IDE 環境中執行實際操作
  </div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-blue">
    <div class="wiki-label">9. 結果回傳</div>
    執行結果透過 WS 回傳到 always-accompany 後端，入列等待處理
  </div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-purple">
    <div class="wiki-label">10. 注入下輪對話</div>
    工具執行結果注入到下一輪 AI 對話的上下文中，AI 據此決定後續操作
  </div>
</div>

## 四條呼叫路徑

工具呼叫不只有 AI 主動發起一條路徑，共有四條入口：

| 路徑 | 觸發方式 | 說明 |
|------|---------|------|
| AI 主動呼叫 | AI 回覆中包含 `<ideToolCall>` | 主鏈路，經 ReplyHandler 解析後走完整安全閘 |
| 前端手動呼叫 | 使用者在連接面板底部手動傳送 | 選擇工具 + 填參數 + 傳送，跳過 AI 環節直接走 callTool |
| 分身呼叫 | 子模式/分身 AI 發起 | 與主鏈路相同，但可能繫結不同的權限等級 |
| dispatch 排程 | 系統內部自動觸發 | 如自動快照（_checkpoint_start）、診斷推送等，內部工具不經審核 |

## WebSocket 訊息類型

always-accompany 後端與 YonBan 擴充套件之間的 WS 通訊使用以下訊息類型：

| 訊息類型 | 方向 | 說明 |
|---------|------|------|
| tool_call | 後端 → 擴充套件 | 工具呼叫請求，包含工具名和參數 |
| tool_result | 擴充套件 → 後端 | 工具執行結果，包含回傳值或錯誤資訊 |
| hello | 擴充套件 → 後端 | 連接交握，上報編輯器類型/版本 |
| status | 擴充套件 → 後端 | 擴充套件狀態上報（開啟檔案/活動編輯器/診斷資訊） |
| console | 擴充套件 → 後端 | IDE 終端機/主控台輸出轉發 |
| ping / pong | 雙向 | 心跳保活，偵測連接存活 |

## 失敗定位

工具呼叫失敗時，沿鏈路逐步排查：

| 症狀 | 可能的斷點 |
|------|-----------|
| AI 沒有呼叫工具 | 步驟 1 — 預設集/提示詞中未啟用 IDE 工具 |
| 呼叫被拒絕 | 步驟 4-5 — 權限等級不足或被使用者拒絕 |
| 呼叫逾時無回應 | 步驟 7 — WS 連接斷開，檢查連接面板狀態燈 |
| 執行報錯 | 步驟 8 — 本機環境問題（檔案不存在/權限不足） |
| AI 沒有收到結果 | 步驟 9-10 — 結果回傳或注入異常 |

## 導覽

- [YonBan 概覽](overview.md) — 安裝與連接
- [工具列表](tools.md) — 30+ 工具速查
- [審核與權限](approval.md) — 五級安全閘詳解
- [訊息管線](beilu:wiki/developer/message-pipeline.md) — ReplyHandler 在管線中的位置

# 外掛

在[外掛管理](beilu:settings/plugins)面板查看和設定所有外掛。always-accompany 內建 18 個外掛，按功能分組如下。

## 外掛清單

<div class="wiki-group">
<div class="wiki-group-title">核心外掛 <span class="wiki-badge-red">核心</span></div>
<div class="wiki-grid wiki-grid-3">
<div class="wiki-card" style="border-left-color: var(--wiki-red, #ef4444);">
<div class="wiki-card-title">beilu-memory</div>
<div class="wiki-card-desc">記憶系統（表格/熱層/歸檔/召回）</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-red, #ef4444);">
<div class="wiki-card-title">beilu-preset</div>
<div class="wiki-card-desc">預設集引擎（提示詞組裝）</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-red, #ef4444);">
<div class="wiki-card-title">beilu-worldbook</div>
<div class="wiki-card-desc">世界書（關鍵詞觸發的背景注入）</div>
</div>
</div>
</div>

<div class="wiki-group">
<div class="wiki-group-title">工具外掛 <span class="wiki-badge-green">工具</span></div>
<div class="wiki-grid wiki-grid-3">
<div class="wiki-card" style="border-left-color: var(--wiki-green, #22c55e);">
<div class="wiki-card-title">beilu-files</div>
<div class="wiki-card-desc">沙箱化檔案讀寫刪執行</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-green, #22c55e);">
<div class="wiki-card-title">beilu-web</div>
<div class="wiki-card-desc">聯網搜尋與網頁瀏覽</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-green, #22c55e);">
<div class="wiki-card-title">beilu-ppt</div>
<div class="wiki-card-desc">PPT 產生</div>
</div>
</div>
</div>

<div class="wiki-group">
<div class="wiki-group-title">感知外掛 <span class="wiki-badge-blue">感知</span></div>
<div class="wiki-grid wiki-grid-3">
<div class="wiki-card" style="border-left-color: var(--wiki-blue, #3b82f6);">
<div class="wiki-card-title">beilu-eye</div>
<div class="wiki-card-desc">桌面截圖感知 + Electron 桌寵</div>
</div>
</div>
</div>

<div class="wiki-group">
<div class="wiki-group-title">增強外掛 <span class="wiki-badge">增強</span></div>
<div class="wiki-grid wiki-grid-3">
<div class="wiki-card" style="border-left-color: var(--wiki-amber, #f59e0b);">
<div class="wiki-card-title">beilu-regex</div>
<div class="wiki-card-desc">正規表示式腳本引擎（AI 回覆後處理）</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-amber, #f59e0b);">
<div class="wiki-card-title">beilu-mvu</div>
<div class="wiki-card-desc">變數系統（區域/全域變數讀寫）</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-amber, #f59e0b);">
<div class="wiki-card-title">beilu-ejs</div>
<div class="wiki-card-desc">EJS 範本渲染</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-amber, #f59e0b);">
<div class="wiki-card-title">beilu-toggle</div>
<div class="wiki-card-desc">條目動態開關（預設集/世界書條目）</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-amber, #f59e0b);">
<div class="wiki-card-title">beilu-vectordb</div>
<div class="wiki-card-desc">向量資料庫（語義檢索）</div>
</div>
</div>
</div>

<div class="wiki-group">
<div class="wiki-group-title">基礎與開發 <span class="wiki-badge-blue">基礎/開發</span></div>
<div class="wiki-grid wiki-grid-3">
<div class="wiki-card" style="border-left-color: var(--wiki-purple, #8b5cf6);">
<div class="wiki-card-title">beilu-sysinfo</div>
<div class="wiki-card-desc">系統監控（CPU/記憶體/網路）</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-purple, #8b5cf6);">
<div class="wiki-card-title">beilu-logger</div>
<div class="wiki-card-desc">日誌記錄</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-purple, #8b5cf6);">
<div class="wiki-card-title">beilu-plugin-host</div>
<div class="wiki-card-desc">使用者外掛宿主</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-purple, #8b5cf6);">
<div class="wiki-card-title">beilu-tutorial</div>
<div class="wiki-card-desc">應用程式內教學 / wiki（本說明頁由它渲染）</div>
</div>
</div>
</div>

## 外掛設定

每個外掛有獨立的設定面板（在[外掛管理](beilu:settings/plugins)中點擊對應外掛即可開啟）。安全敏感的設定寫入（如 beilu-files 的 allowExec、beilu-ejs 的 sandboxOptOut）需要實例 owner 權限。詳見 [安全中心](../security/overview.md)（[前往安全中心](beilu:settings/security)）。

## 使用者外掛

透過 beilu-plugin-host，可以編寫和載入自訂外掛。使用者外掛與內建外掛享有相同的介面能力。詳見 [外掛開發](../developer/plugin-dev.md)。

## 深入了解：外掛介面

每個外掛透過標準介面與核心系統互動：

### 資料介面

| 介面 | 方向 | 說明 |
|------|------|------|
| GetData | 核心 -> 外掛 | 讀取外掛設定和狀態 |
| SetData | 核心 -> 外掛 | 寫入外掛設定或觸發動作 |

### 訊息管線介面

| 介面 | 調用時機 | 說明 |
|------|---------|------|
| GetPrompt | 訊息發送前 | 回傳外掛要注入到提示詞中的內容 |
| TweakPrompt | GetPrompt 之後 | 修改/調整已組裝的提示詞結構（三輪執行） |
| ReplyHandler | AI 回覆後 | 解析 AI 回覆中的標籤/指令並執行 |
| GetReply | 產生調用時 | 攔截或修改 AI 調用請求 |

### 外掛調用順序

在一次完整的訊息收發週期中，外掛按以下順序參與：

<div class="wiki-flow">
<div class="wiki-box wiki-box-green wiki-box-full"><b>使用者發訊息</b><small>觸發訊息管線</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-amber wiki-box-full"><b>1. GetPrompt</b><small>並行收集各外掛的提示詞片段</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-blue wiki-box-full"><b>2. TweakPrompt x 3 輪</b><small>Round 1 (dl=2): 收集清空 | Round 2 (dl=1): 重建訊息序列 | Round 3 (dl=0): 快照</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-purple wiki-box-full"><b>3. StructCall</b><small>調用 AI API（由 provider/產生器執行）</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-red wiki-box-full"><b>4. ReplyHandler</b><small>解析 AI 回覆中的操作標籤</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-green wiki-box-full"><b>儲存 + 廣播</b><small>持久化訊息並通知前端</small></div>
</div>

### 外掛的載入

**預設外掛**：always-accompany 啟動時自動載入 `defaultParts.plugins` 中列出的外掛。核心外掛（memory / preset / worldbook 等）始終參與每次對話。

**對話級外掛**：建立對話時，系統會將預設外掛合併到對話的 timeSlice 中。後續新增到預設清單的外掛也會自動加入。

## 快速導覽

- [檔案操作 (beilu-files)](files.md) — AI 檔案讀寫
- [螢幕感知 (beilu-eye)](eye.md) — 桌面截圖與桌寵
- [聯網搜尋 (beilu-web)](web.md) — 搜尋與網頁瀏覽
- [正規表示式增強 (beilu-regex)](regex.md) — AI 回覆後處理
- [變數系統 (beilu-mvu)](mvu.md) — 變數讀寫
- [腳本引擎](scripts.md) — EJS 範本與腳本
- [外掛開發](../developer/plugin-dev.md) — 編寫自訂外掛

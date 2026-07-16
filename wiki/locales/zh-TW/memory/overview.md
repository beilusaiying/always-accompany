# 記憶系統

AI 自動記住對話中的重要內容——角色性格、使用者偏好、發生過的事件，跨對話不丟失。

## 你需要做什麼

**通常不需要管。** 記憶系統全自動運行：AI 自己寫入、自己召回、自己歸檔。

想手動管理時：進入[記憶管理](beilu:mode/memory)，可以查看、編輯、刪除任何記憶條目。

## 自動運行流程

<div class="wiki-flow">
<div class="wiki-box wiki-box-blue"><b>使用者發訊息</b></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-amber"><b>從 hot 層取常駐記憶</b></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-blue"><b>召回引擎掃描 warm 層</b><small>比對相關條目</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-green"><b>拼入上下文發給 AI</b></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-purple"><b>AI 回覆含 &lt;tableEdit&gt;</b><small>寫回記憶表格</small></div>
</div>

## 三層記憶架構

記憶按「溫度」分層，越熱的層離 AI 越近：

<div class="wiki-layers">
<div class="wiki-layer wiki-layer-amber">
<span class="wiki-layer-label">hot 熱層</span>
活躍記憶，每輪對話自動注入上下文 <span class="wiki-badge">自動</span>
</div>
<div class="wiki-layer wiki-layer-blue">
<span class="wiki-layer-label">warm 溫層</span>
近期記憶，按需召回（關鍵詞比對時拉入） <span class="wiki-badge wiki-badge-blue">召回引擎觸發</span>
</div>
<div class="wiki-layer wiki-layer-purple">
<span class="wiki-layer-label">cold 冷層</span>
歸檔記憶，長期儲存，搜尋可達 <span class="wiki-badge wiki-badge-green">主動搜尋</span>
</div>
</div>

## 記憶表格

記憶以**結構化表格**儲存，chat 模式下有 #0 到 #9 共 10 張表，分別對應不同類型的資訊（時空、角色特徵、關於使用者等）。AI 透過 `<tableEdit>` 標籤對表格進行增刪改查。

詳見 [記憶表格(#0-#9)](tables.md)。也可在[記憶管理](beilu:mode/memory)中查看和管理。

## 記憶的生命週期

<div class="wiki-flow">
<div class="wiki-box wiki-box-green"><b>新資訊產生</b></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-amber"><b>AI 寫入 hot 層表格</b><small>&lt;tableEdit&gt; 標籤</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-amber"><b>hot 層記憶每輪自動注入上下文</b></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-label">隨時間推移</div>
<div class="wiki-box wiki-box-blue"><b>自動搬遷到 warm 層</b></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-label">繼續老化</div>
<div class="wiki-box wiki-box-purple"><b>搬遷到 cold 層歸檔</b></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-green"><b>召回引擎從 warm/cold 層檢索拉回</b><small>需要時</small></div>
</div>

## 記憶管理介面

在[記憶管理](beilu:mode/memory)中，頂部工具列提供 7 個快捷按鈕：

| 按鈕 | 名稱 | 功能 |
|------|------|------|
| table | 表格 | 開啟[資料表格編輯器](tables.md)，直接編輯 #0-#9 表格內容 |
| diag | P1診斷 | 查看 P1 召回引擎的運行狀態與快取 |
| snapshot | 快照 | 管理[記憶快照與 Git 快照](archival.md)，可建立/恢復 |
| retrieval | 檢索設定 | 調整 P1 自動觸發、引用條數、搜尋輪數、逾時等參數 |
| format | 格式檢查 | 掃描記憶檔案，統計格式符合/警告/錯誤，支援一鍵升級 |
| pseries | P系列引擎 | 編輯 [P1-P8 各預設集](presets.md)的提示詞、AI 源、模型等參數 |
| skills | 說明書庫 | 管理不同模式下的說明書（觸發規則、正文等） |

### 就地設定條（T040a）

管理面板常駐一條設定 chip 條，快速調整常用參數：

- P1 自動觸發 toggle — 開關 P1 每輪自動召回
- 引用條數 number — 控制召回注入的條目數量
- 搜尋輪數 number — P1 多輪搜尋的最大輪次
- 「更多設定」按鈕 — 展開完整檢索設定面板

### 三層主區

- **記憶內容**（content）— 子 Tab：檔案樹 / 表格。瀏覽和編輯記憶檔案與表格資料
- **檢索/診斷**（diagretr）— 子 Tab：診斷 / 檢索。查看 P1 運行狀態與調整檢索參數
- **記憶運維**（ops）— 子 Tab：快照 / 格式 / 匯入匯出。備份恢復與格式維護

### 記憶檔案瀏覽器

檔案樹展示 hot / warm / cold / code / work 五層目錄結構：

- 以 `_` 開頭和 `.bak` 檔案預設隱藏，各層有專用圖示對應
- 每個檔案顯示大小和相對時間
- 點擊檔案在右欄開啟 JSON 編輯器，可直接修改並儲存

**歸檔工具列**提供批次操作：歸檔臨時記憶 / 結束當天 / Hot 轉 Warm / Warm 轉 Cold / 歸檔已完成任務。

**code 層專用工具**：正規表示式搜尋、新建資料夾、匯入/匯出 zip。

## 深入了解

### 記憶 AI 預設集

記憶系統幕後有 8 個專用 AI 預設集協同工作：

- **P1**：檢索 AI——NLP 分詞、聯想擴展、四維打分，從溫/冷層召回記憶
- **P2**：表格總結/歸檔——臨時記憶超閾值時產生總結並歸檔到溫層
- **P3**：每日總結——日終匯總當天事件
- **P4**：熱→溫轉移——將過期/低權重記憶移入溫層
- **P5**：月度總結/歸檔——為溫層月份編纂月總結
- **P6**：格式檢查/修復——維護表格與記憶檔案的格式
- **P7**：壓縮 AI——當上下文過長時產生摘要
- **P8**：聯網搜尋——需要外部資訊時調用

詳見 [記憶AI預設集(P1-P8)](presets.md)。

### 與世界書的關係

記憶系統管理的是**動態產生的資訊**（對話中發生的事、AI 學到的東西）。世界書管理的是**預先設定的背景知識**（世界觀設定、角色資料、規則）。兩者都透過注入系統（INJ）送入上下文，但來源和管理方式不同。

## 導覽

- [記憶表格(#0-#9)](tables.md) — 表格結構與各表職能
- [熱層記憶](hot-layer.md) — hot 層檔案與自動注入機制
- [記憶AI預設集(P1-P8)](presets.md) — 各預設集的分工與運行鏈
- [上下文壓縮](compression.md) — P7 壓縮機制
- [記憶歸檔與檢索](archival.md) — warm/cold 層搬遷與召回引擎
- [世界書概覽](worldbook-overview.md) — 預先設定的背景知識系統（[世界書編輯](beilu:editor/worldbook)）
- [注入系統概覽](inj-overview.md) — 資訊如何進入上下文

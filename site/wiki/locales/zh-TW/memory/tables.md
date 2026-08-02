# 記憶表格(#0-#9)

記憶表格是 always-accompany 記憶系統的核心儲存結構。AI 透過 `<tableEdit>` 標籤對表格進行 CRUD（增刪改查）操作，每張表對應一類資訊。不同工作模式（[聊天模式](beilu:mode/chat) / code / [工作模式](beilu:mode/work)）使用不同的表格集。

## chat 模式表格

chat 模式使用 #0 到 #9 共 10 張表：

<div class="wiki-grid wiki-grid-2">
<div class="wiki-card"><div class="wiki-card-title">#0 時空</div><div class="wiki-card-desc">目前時間、地點、場景 — AI 感知「現在在哪、幾點了」</div></div>
<div class="wiki-card"><div class="wiki-card-title">#1 角色特徵</div><div class="wiki-card-desc">角色的性格、外貌、習慣等 — AI 保持角色一致性</div></div>
<div class="wiki-card"><div class="wiki-card-title">#2 社交</div><div class="wiki-card-desc">人際關係、好感度、互動歷史 — AI 理解角色間的關係</div></div>
<div class="wiki-card"><div class="wiki-card-title">#3 任務</div><div class="wiki-card-desc">目前進行中的任務、目標 — AI 追蹤任務進度</div></div>
<div class="wiki-card"><div class="wiki-card-title">#4 臨時記憶</div><div class="wiki-card-desc">短期事件、臨時狀態 — 本次對話中的臨時資訊</div></div>
<div class="wiki-card"><div class="wiki-card-title">#5 物品</div><div class="wiki-card-desc">持有的物品、道具 — 物品管理</div></div>
<div class="wiki-card"><div class="wiki-card-title">#6 日總結</div><div class="wiki-card-desc">每日總結資訊 — 回顧過去發生了什麼</div></div>
<div class="wiki-card"><div class="wiki-card-title">#7 關於使用者</div><div class="wiki-card-desc">使用者的偏好、習慣、個人資訊 — AI 了解使用者</div></div>
<div class="wiki-card"><div class="wiki-card-title">#8 永遠記住</div><div class="wiki-card-desc">重要的、不應遺忘的資訊 — 核心設定、重要承諾</div></div>
<div class="wiki-card"><div class="wiki-card-title">#9 時空記憶</div><div class="wiki-card-desc">與時空相關的長期記憶 — 地點關聯的回憶</div></div>
</div>

## code 模式表格

code 模式使用 C0 到 C5 共 6 張表，面向程式碼輔助情境：

<div class="wiki-grid wiki-grid-3">
<div class="wiki-card"><div class="wiki-card-title">C0</div><div class="wiki-card-desc">專案上下文</div></div>
<div class="wiki-card"><div class="wiki-card-title">C1</div><div class="wiki-card-desc">程式碼約定與規範</div></div>
<div class="wiki-card"><div class="wiki-card-title">C2</div><div class="wiki-card-desc">目前任務</div></div>
<div class="wiki-card"><div class="wiki-card-title">C3</div><div class="wiki-card-desc">技術棧與相依性</div></div>
<div class="wiki-card"><div class="wiki-card-title">C4</div><div class="wiki-card-desc">問題與解決方案</div></div>
<div class="wiki-card"><div class="wiki-card-title">C5</div><div class="wiki-card-desc">臨時筆記</div></div>
</div>

## work 模式表格

work 模式使用 W0 到 W4 共 5 張表，面向工作流情境：

<div class="wiki-grid wiki-grid-3">
<div class="wiki-card"><div class="wiki-card-title">W0</div><div class="wiki-card-desc">工作上下文</div></div>
<div class="wiki-card"><div class="wiki-card-title">W1</div><div class="wiki-card-desc">任務與進度</div></div>
<div class="wiki-card"><div class="wiki-card-title">W2</div><div class="wiki-card-desc">聯絡人與協作</div></div>
<div class="wiki-card"><div class="wiki-card-title">W3</div><div class="wiki-card-desc">決策記錄</div></div>
<div class="wiki-card"><div class="wiki-card-title">W4</div><div class="wiki-card-desc">臨時筆記</div></div>
</div>

## AI 如何操作表格

AI 在回覆中使用 `<tableEdit>` 標籤進行表格操作。系統解析該標籤後執行對應的 CRUD 動作：

- **Create**：新增一列記錄
- **Read**：查詢表格內容（通常透過召回引擎自動完成）
- **Update**：修改已有記錄
- **Delete**：刪除過時的記錄

標籤內部使用函式呼叫式語法（這也是系統注入給 AI 的操作格式）：

```
<tableEdit>
<!--
insertRow(表格編號, {列編號: "值", ...})
updateRow(表格編號, 行編號, {列編號: "新值", ...})
deleteRow(表格編號, 行編號)
-->
</tableEdit>
```

操作由記憶系統的 INJ 指令引導——INJ-1 會告訴 AI 目前模式下可用哪些表、每張表存什麼、用什麼格式寫入。

## 運行鏈

<div class="wiki-flow">
<div class="wiki-box wiki-box-blue"><b>AI 產生回覆</b><small>回覆中包含 &lt;tableEdit&gt; 標籤</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-green"><b>後端記憶系統解析 &lt;tableEdit&gt; 標籤</b></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-amber"><b>根據表編號定位對應表格檔案</b></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-amber"><b>執行 CRUD 操作寫入 hot 層</b></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-green"><b>下一輪對話時</b><small>hot 層表格內容自動注入上下文</small></div>
</div>

## 表格與三層架構的關係

<div class="wiki-layers">
<div class="wiki-layer wiki-layer-amber">
<span class="wiki-layer-label">hot 熱層</span>
目前活躍的表格內容，每輪注入
</div>
<div class="wiki-layer wiki-layer-blue">
<span class="wiki-layer-label">warm 溫層</span>
近期但不再活躍的表格條目，按需召回
</div>
<div class="wiki-layer wiki-layer-purple">
<span class="wiki-layer-label">cold 冷層</span>
歸檔的歷史條目，搜尋可達
</div>
</div>

表格條目隨時間自動從 hot 搬遷到 warm，再到 cold。搬遷由記憶系統的歸檔管線自動執行。

## 資料表格編輯器

在[記憶管理](beilu:mode/memory)中點擊工具列的 **table** 按鈕，或在記憶內容區切換到「表格」子 Tab，可開啟資料表格編輯器。

### 表格切換

頂部顯示 #0 到 #9（或 C0-C5 / W0-W4，按目前 viewMode）的 Tab 頁籤，點擊切換不同表格。每張表的名稱可直接點擊編輯。

### 儲存格編輯

點擊任意儲存格進入就地編輯狀態，修改後自動儲存。欄標題也可點擊編輯，用於調整欄名。

### 規則區

表格下方的規則區定義該表的寫入規則與格式約束。每張表可獨立設定，AI 寫入時會參照這些規則。

### 列操作

- **新增列**：在表格底部追加新列
- **刪除列**：支援多選批次刪除
- **啟用/停用 toggle**：控制表格條目是否參與注入

### 搜尋

表格內建搜尋功能，可按關鍵詞在目前表格中篩選比對的列。

### 樂觀並行控制

表格編輯採用版本號機制：每次儲存時檢查版本號，若其他來源（如 AI 的 `<tableEdit>`）已修改表格導致版本不一致，系統會提示衝突，防止覆蓋丟失。

### 快照

表格編輯器內可建立目前表格的快照，便於在調整前留存備份。詳見[記憶歸檔與檢索](archival.md)中的快照管理部分。

## 注意事項

- 各模式的表格互相獨立，切換模式時載入對應的表格集
- 表格編號是固定的，每個編號對應的職能由 INJ-1 指令定義
- AI 寫入表格的格式需要符合系統解析要求，否則寫入會被忽略

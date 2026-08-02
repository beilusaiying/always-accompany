# 模式系統

按 Ctrl+1~4（或 Alt+1~4）切換模式，每個模式是一套獨立的工作環境——不同的佈局、面板和 AI 行為。

## 四大主模式

<div class="wiki-grid wiki-grid-2">
<div class="wiki-card" style="border-left-color: var(--wiki-amber, #f59e0b);">
<div class="wiki-card-title">Smart 全智能 <span class="wiki-badge">Ctrl+1 / Alt+1</span></div>
<div class="wiki-card-desc">三欄（左右可摺疊）<br>人設管理、世界書、任務看板</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-amber, #f59e0b);">
<div class="wiki-card-title">Chat/AIRP 聊天 <span class="wiki-badge">Ctrl+2 / Alt+2</span></div>
<div class="wiki-card-desc">三欄<br>角色扮演對話、預設集管理</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-amber, #f59e0b);">
<div class="wiki-card-title">Code/IDE 程式碼 <span class="wiki-badge">Ctrl+3 / Alt+3</span></div>
<div class="wiki-card-desc">IDE 樣式（活動欄+側邊欄+主區）<br>程式碼編寫、檔案瀏覽、程式輔助</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-amber, #f59e0b);">
<div class="wiki-card-title">Work 工作 <span class="wiki-badge">Ctrl+4 / Alt+4</span></div>
<div class="wiki-card-desc">IDE 樣式<br>任務管理、審批、委派、定時任務</div>
</div>
</div>

切換模式時，系統自動載入該模式綁定的預設集、API 源和模型參數，AI 行為隨之改變。

## 四大輔助檢視

透過輔助功能表進入，提供管理和設定介面：

<div class="wiki-grid wiki-grid-2">
<div class="wiki-card" style="border-left-color: var(--wiki-blue, #3b82f6);">
<div class="wiki-card-title">Bot 管理 <span class="wiki-badge-blue">輔助功能表</span></div>
<div class="wiki-card-desc">多平台 Bot 設定與權限管理</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-blue, #3b82f6);">
<div class="wiki-card-title">Companion 遊戲陪伴 <span class="wiki-badge-blue">輔助功能表</span></div>
<div class="wiki-card-desc">桌寵、Live2D、AI 自主行為</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-blue, #3b82f6);">
<div class="wiki-card-title">Memory 記憶管理 <span class="wiki-badge-blue">輔助功能表</span></div>
<div class="wiki-card-desc">記憶表格檢視編輯、AI 預設集執行</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-blue, #3b82f6);">
<div class="wiki-card-title">Helper ST 適配 <span class="wiki-badge-blue">輔助功能表</span></div>
<div class="wiki-card-desc">正規表示式腳本、變數管理、ST 相容工具</div>
</div>
</div>

## 子模式

[Code](beilu:mode/files) 和 [Work](beilu:mode/work) 模式各有 11 個子模式，用於更精細地劃分工作階段。每個子模式可獨立綁定預設集、API 源、模型和採樣參數。詳見 [子模式與切換](beilu:wiki/modes/submodes.md)。

## 深入了解：兩層模式架構

always-accompany 的模式分為兩層：

| 層級 | 說明 | 可選值 |
|------|------|--------|
| 後端模式（B 通道） | 權威模式值，決定 AI 行為和預設集載入 | `chat` / `smart` / `code` / `work` / `bot` |
| 前端 Tab（UI 檢視） | 介面展示層，決定佈局和面板 | `smart` / `chat` / `files` / `work` / `memory` / `bot` / `companion` / `helper` / `settings` / `editor` |

後端模式是權威源，前端 Tab 是檢視層。一個後端模式可能對應多個前端 Tab（例如 `chat` 模式同時承載 Chat、Bot、Helper 等檢視），但每個 Tab 最多映射到一個後端模式。

### 模式與 Tab 的映射關係

**正向映射**（後端模式 → 前端 Tab）：

<div class="wiki-layers">
<div class="wiki-layer wiki-layer-amber">
<b>後端模式（B 通道）</b>
<div class="wiki-row">
<div class="wiki-box wiki-box-amber"><b>chat</b><small>→ chat</small></div>
<div class="wiki-box wiki-box-amber"><b>smart</b><small>→ smart</small></div>
<div class="wiki-box wiki-box-amber"><b>code</b><small>→ files</small></div>
<div class="wiki-box wiki-box-amber"><b>work</b><small>→ work</small></div>
</div>
</div>
</div>

**反向映射**（前端 Tab → 後端模式）：

<div class="wiki-layers">
<div class="wiki-layer wiki-layer-amber">
<b>主模式 Tab（切換後端模式）</b>
<div class="wiki-row">
<div class="wiki-box wiki-box-amber"><b>chat</b><small>→ chat 聊天模式</small></div>
<div class="wiki-box wiki-box-amber"><b>airp</b><small>→ chat AIRP 角色扮演</small></div>
<div class="wiki-box wiki-box-amber"><b>smart</b><small>→ smart 全智能模式</small></div>
<div class="wiki-box wiki-box-amber"><b>bot</b><small>→ chat Bot 管理</small></div>
<div class="wiki-box wiki-box-amber"><b>helper</b><small>→ chat ST 適配</small></div>
<div class="wiki-box wiki-box-amber"><b>files</b><small>→ code IDE 程式碼</small></div>
<div class="wiki-box wiki-box-amber"><b>work</b><small>→ work 工作模式</small></div>
</div>
</div>
<div class="wiki-layer wiki-layer-blue">
<b>純檢視 Tab（不切換後端模式）</b>
<div class="wiki-row">
<div class="wiki-box wiki-box-blue"><b>memory</b><small>純檢視</small></div>
<div class="wiki-box wiki-box-blue"><b>companion</b><small>純檢視</small></div>
<div class="wiki-box wiki-box-blue"><b>settings</b><small>純檢視</small></div>
<div class="wiki-box wiki-box-blue"><b>editor</b><small>純檢視</small></div>
</div>
</div>
</div>

### 模式切換流程

使用者觸發模式切換後，系統執行以下流程：

<div class="wiki-flow">
<div class="wiki-box wiki-box-green wiki-box-full"><b>1. 使用者操作</b><small>點擊頂部選擇器 / 按快捷鍵 / 點擊輔助功能表</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-blue wiki-box-full"><b>2. switchTab(tabName)</b><small>前端切換 UI 檢視</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-amber wiki-box-full"><b>3. switchModeTo(targetMode)</b><small>如果 Tab 映射了後端模式，觸發後端模式切換</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-purple wiki-box-full"><b>4. 後端 switchMode</b><small>持久化模式值並廣播給所有連線</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-green wiki-box-full"><b>5. 前端更新</b><small>收到廣播後更新 UI、恢復對應的 chatId</small></div>
</div>

## 快速導航

- [聊天模式 (Chat/AIRP)](beilu:wiki/modes/chat.md) - 角色扮演與日常對話
- [程式碼模式 (Code/IDE)](beilu:wiki/modes/ide.md) - AI 輔助程式開發
- [工作模式 (Work)](beilu:wiki/modes/work.md) - 任務管理與工作流
- [Bot 模式](beilu:wiki/modes/bot.md) - 多平台 Bot 管理
- [遊戲陪伴模式](beilu:wiki/modes/game.md) - 桌寵與 Live2D
- [子模式與切換](beilu:wiki/modes/submodes.md) - 子模式詳解

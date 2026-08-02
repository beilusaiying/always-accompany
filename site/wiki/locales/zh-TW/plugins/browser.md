# 瀏覽器自動化 (beilu-browser)

beilu-browser 讓 AI 能夠控制一個真實的 Chrome 瀏覽器。AI 透過 `<browser_op>` 標籤發起瀏覽器操作，外掛解析標籤、執行操作、將結果注入下一輪對話。

> 沿革說明：早期版本另有一條「前端觸發瀏覽器頁面快照注入訊息」的通道，已於 2026-07-16 移除。現在的瀏覽器自動化統一走本頁描述的 `<browser_op>` 對話內標籤協定——外掛本體持續維護中，並未隨舊通道一起刪除。

## 運作原理

```
AI 回覆中包含 <browser_op> 標籤
    ↓
ReplyHandler 解析標籤
    ↓
呼叫 browser-driver 執行操作（CDP WebSocket → Chrome）
    ↓
結果存入待注入佇列（按對話隔離）
    ↓
下一輪 GetPrompt 將結果注入對話
    ↓
AI 看到結果，決定下一步操作
```

## 前置條件

Chrome 需以遠端偵錯模式啟動。最簡單的方式：在「額外外掛 → 瀏覽器自動化」面板點擊**啟動 Chrome**按鈕（自動偵測 Chrome 路徑並以正確參數啟動）。

手動啟動等價指令：

```
chrome --remote-debugging-port=9222 --user-data-dir=data/browser-profile
```

- `--remote-debugging-port` 連接埠號可在外掛設定中修改
- `--user-data-dir` 獨立使用者目錄（預設在 beilu 資料目錄下，可在面板設定），共享登入狀態

## 操作標籤

### 導覽

| 標籤 | 說明 |
|------|------|
| `<browser_op type="goto" url="https://..." />` | 開啟指定 URL |
| `<browser_op type="tabs" />` | 列出所有分頁 |
| `<browser_op type="newtab" url="https://..." />` | 開啟新分頁 |
| `<browser_op type="closetab" />` | 關閉目前分頁 |
| `<browser_op type="sync" />` | 同步到你正在瀏覽的分頁（人機共享同一瀏覽器，AI 接續你所在的頁面操作） |

### 頁面檢查

| 標籤 | 說明 |
|------|------|
| `<browser_op type="snapshot" />` | 取得頁面無障礙樹（accessibility tree），每個元素帶 @N 參照號 |
| `<browser_op type="screenshot" />` | 擷取頁面截圖，儲存為 PNG |

### 互動操作

使用 snapshot 回傳的 @N 參照號定位元素：

| 標籤 | 說明 |
|------|------|
| `<browser_op type="click" target="@3" />` | 點擊元素 |
| `<browser_op type="type" target="@3" value="輸入文字" />` | 在輸入框中輸入文字 |
| `<browser_op type="press" key="Enter" />` | 按下鍵盤按鍵 |
| `<browser_op type="scroll" dy="300" />` | 捲動頁面（dy 正值向下，負值向上） |

### JavaScript 執行

```xml
<browser_op type="eval">document.title</browser_op>
```

### 等待

```xml
<browser_op type="wait" selector="css:.result" timeout="5000" />
```

### 瀏覽內容記錄

```xml
<browser_op type="history" />
```

開啟「瀏覽內容記錄」後，每次瀏覽器操作的頁面 URL、標題與結果摘要會記錄到本機檔案（預設 `data/browser-history.jsonl`）。AI 透過 `history` 操作回讀最近記錄，實現跨輪瀏覽記憶；記錄開關與回讀筆數可在面板設定。

## 典型工作流程

1. `goto` 導覽到目標頁面
2. `snapshot` 查看頁面結構，取得元素的 @N 參照號
3. `click` / `type` 與頁面互動
4. `snapshot` 再次查看結果，確認操作成功
5. 重複直到任務完成

## 巨集

beilu-browser 透過 macro_env 提供以下巨集，可在 INJ 條目或預設集中使用：

| 巨集 | 說明 |
|----|------|
| `{{browser_status}}` | 瀏覽器連線狀態（connected / disconnected） |
| `{{browser_port}}` | CDP 偵錯連接埠號 |

## INJ 條目

外掛首次載入時自動建立 `INJ-browser` 條目，包含 AI 的瀏覽器操作能力說明。你可以在 INJ 編輯器中自由修改其內容、深度、模式門控等設定。

- **預設深度**: 1（system 區域）
- **預設模式**: always（全模式生效）
- **支援巨集**: 內容中可使用 `{{browser_status}}`、`{{browser_port}}` 等巨集

## 設定項目

全部設定可在「額外外掛 → 瀏覽器自動化」面板設定：

| 設定 | 預設值 | 說明 |
|------|--------|------|
| enabled | true | 外掛總開關 |
| port | 9222 | Chrome 遠端偵錯連接埠 |
| snapshotMaxLines | 200 | 快照最大行數（防止超長頁面撐爆上下文） |
| chromePath | 空（自動偵測） | Chrome 可執行檔路徑 |
| userDataDir | data/browser-profile | Chrome 使用者資料目錄（相對 beilu 資料目錄） |
| driverPath | 空（內建驅動） | 留空使用隨 beilu 發布的內建驅動，可指定外部驅動 file:// URL |
| defaultTimeout | 5000 | wait 操作預設逾時（ms） |
| defaultScrollDy | 300 | scroll 預設捲動量（px） |
| gotoWaitUntil | load | 導覽等待策略（load / domcontentloaded / commit） |
| resultLabel / resultSeparator | — | 結果注入的區塊標題與分隔符 |
| autoReconnect | true | 操作失敗後自動重連 |
| recordBrowsing | true | 瀏覽內容記錄開關 |
| historyFile | data/browser-history.jsonl | 瀏覽記錄落盤檔案 |
| historyMaxRead | 30 | history 操作預設回讀筆數 |

## 安全

- **內網防護**：`goto` / `newtab` 的 URL 經統一出站安全校驗（safe_fetch），私有網路/回環/雲端中繼資料位址一律拒絕——AI 無法驅動瀏覽器探測內網。
- **內容邊界**：網頁標題、快照、eval 結果等外部內容注入 AI 前經不可信內容邊界處理（尖括號中性化 + 隨機 nonce 邊界標註），阻斷網頁內容對 AI 的間接指令注入。

## 技術架構

底層驅動內建於外掛目錄（`beilu-browser/driver/`，隨 beilu 本體發布，零外部相依），透過 Chrome DevTools Protocol (CDP) 原生 WebSocket 直接控制瀏覽器：

- 不相依 Playwright/Puppeteer，零 npm 相依
- 支援 Playwright 風格的 Locator API（CSS / role / text / xpath）
- Input Probe 回退機制：CDP 原生事件失敗時自動用 synthetic event 補發
- Session 自癒：分頁關閉/導覽後自動重附著，preferredTarget 跟隨切換

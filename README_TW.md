<p align="center">
  <img src="imgs/icon.jpg" alt="always accompany" width="200">
</p>

<h1 align="center">always accompany</h1>

<p align="center">
  <a href="https://discord.gg/agHeDq9bqU"><img src="https://img.shields.io/badge/Discord-加入社群-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord"></a>
  &nbsp;
  <a href="https://github.com/beilusaiying/always-accompany"><img src="https://img.shields.io/badge/GitHub-點個_Star_⭐-181717?style=for-the-badge&logo=github" alt="GitHub"></a>
  &nbsp;
  <a href="beilu-presets_2026-02-23.json"><img src="https://img.shields.io/badge/📦_記憶預設-開箱即用-4CAF50?style=for-the-badge" alt="記憶預設"></a>
</p>

<p align="center"><a href="README.md">English</a> | <a href="README_CN.md">簡體中文</a> | 繁體中文 | <a href="README_JA.md">日本語</a> | <a href="README_DE.md">Deutsch</a> | <a href="README_ES.md">Español</a></p>

> 本專案由一名在校大學生獨立完成全部設計、架構與開發，藉助 AI 輔助程式設計，融合演算法設計、仿生學原理、框架架構和邏輯思維等多方面能力。

---

```bash
git clone https://github.com/beilusaiying/always-accompany.git
cd always-accompany
run.bat          # Windows
# 或 chmod +x run.sh && ./run.sh   # Linux/macOS
```

瀏覽器開啟 `http://localhost:1314` → 設定 AI 服務來源 → 匯入角色卡 → 開聊。Deno 執行環境會在首次啟動時自動下載，無需手動安裝。至少需要一個 AI API Key。應用程式內建完整 wiki 教學。

> **提示：** 首次啟動會比較慢——執行環境需要下載相依套件並初始化資料庫，請等待頁面完全載入後再操作。之後的啟動會快很多。

---

一套三層遞迴記憶（日→月→年歸檔，純 JSON，260 年容量）+ 前置檢索 AI（專職從記憶裡找相關內容的，只把找到的交給回覆 AI，兩者各司其職）+ 分層上下文清理（清掉的只是不再傳送，原文仍保留，隨時可復原）。這三件事咬合在一起，讓 AI 不再受上下文視窗限制地記住你說過的每一句話。在此基礎上，我們做了聊天/角色扮演、IDE 程式設計模式、工作模式（含 AI 製作簡報）、Live2D 桌寵（螢幕感知+遊戲陪伴）、語音輸入、Discord Bot、MCP 外部工具接入——所有入口共享同一套記憶，換個視窗 AI 依然認得你。正在優化中的下一代檢索引擎（21 節點純演算法管線，零 LLM 零網路，毫秒級，目標：句子級注意力）。

---

## 功能一覽

<table>
<tr>
<td width="33%">

**💬 聊天 / 角色扮演**
![聊天介面](imgs/screenshots/chat-interface-mode.png)

</td>
<td width="33%">

**🖥️ IDE 程式設計模式**
![IDE程式設計](imgs/screenshots/ide-coding.png)

</td>
<td width="33%">

**📊 工作模式（AI 製作簡報）**
![work模式PPT](imgs/screenshots/work-ppt-mode.png)

</td>
</tr>
<tr>
<td width="33%">

**🐾 Live2D 桌寵 + 螢幕感知**
![桌寵](imgs/screenshots/live2d-pet-mode.png)

</td>
<td width="33%">

**🔒 L0–L5 六檔權限閘**
![權限設定](imgs/screenshots/ai-permissions.png)

</td>
<td width="33%">

**🗜️ 分層壓縮 × 逐條可控**
![壓縮機制](imgs/screenshots/compression-detail.png)

</td>
</tr>
</table>

- **🧠 三層記憶**：熱（每輪注入）/ 溫（按需檢索）/ 冷（深度歸檔），純 JSON + 純提示詞驅動，零資料庫
- **🎯 P1 前置檢索**：專職小型 AI 先找記憶再交給回覆 AI，BM25 + 正規表達式雙引擎，檢索可用免費模型
- **🗜️ 壓縮系統**：三級層次（一鍵/依類型/逐條）× 四類粒度（對話/檔案讀取/系統注入/過程內容）+ AI 自主 `<contextClean>` 清理，全部可回溯
- **📊 10 張記憶表格**：結構化儲存，AI 用 `<tableEdit>` 自動維護，實現資訊隔離（角色不知道的事表格裡就沒有）
- **👑 提示詞引擎**：5 段式訊息結構 + TweakPrompt 三輪接管，巨集變數 + 世界書動態注入（常駐/正規表達式/動態三種模式）
- **💻 IDE 級工作流程**：VSCode 風格三欄，AI 直接讀寫檔案，指令執行逐條審核
- **🔌 MCP 外部工具**：貼上 JSON 即可接入，指令型預設攔下，需 owner 核准才能啟動，env 白名單防洩漏
- **🐾 桌寵 + 遊戲陪伴**：Live2D / 圖片包桌寵，三檔隱私開關，自動截圖+主動搭話+頻率自動調整
- **🎙️ 語音輸入**：本機模型轉錄，講者區分+時間軸，音訊不出機器
- **🤖 跨平台 Bot**：Discord 部署，視覺化管理 + 即時訊息紀錄
- **🧩 22 個功能外掛** + 使用者級外掛宿主 + 生態相容（多種格式角色卡/預設/世界書匯入）
- **🛡️ 資料全在本機**：刪除進資源回收桶可找回，多層自動備份 + git 回檔
- **🌐 多語言**（中/英/日/繁）· **🔬 全端診斷**（12 模組日誌 + 一鍵打包）· **🎨 多套 CSS 主題**

---

## 詳細機制

<details>
<summary><strong>🧠 三層遞迴記憶 — 為什麼要分層</strong></summary>

把全部歷史扔進同一個大池子，查找時就慢——而且實驗數據已經證明（[Lost in the Middle](https://arxiv.org/abs/2307.03172) / [RULER](https://arxiv.org/abs/2404.06654) / [NoLiMa](https://arxiv.org/abs/2502.05167)），扔進去模型也未必看得到。依照人腦海馬迴的記憶形成機制和艾賓浩斯遺忘曲線的思路，我們把資訊依時間距離分成三層：

```
🔥 熱記憶層 — 每輪自動注入：使用者畫像 / 永久記憶 / 未完成任務 / 近期記憶
🌤️ 溫記憶層 — 按需檢索（最近 1 個月）：每日總結 / 臨時歸檔 / 月度索引
❄️ 冷記憶層 — 深度檢索（1 個月以上）：月度總結 / 歷史每日總結 / 年度索引
```

熱層每輪只佔約 7,000–11,000 個 token（128K 視窗的 5–9%）。記憶衰減借鑑艾賓浩斯遺忘曲線：`score = weight × (1 / (1 + days × 0.1))`。純提示詞驅動——改歸檔策略、表格意涵、檢索風格，改提示詞就行，不用動程式碼。

</details>

<details>
<summary><strong>🎯 P1 前置檢索 AI — 為什麼拆成兩個 AI</strong></summary>

讓回覆 AI 自己在幾百條歷史裡挑相關的，牠既要找又要回覆，注意力在兩件事之間被稀釋。把「找記憶」拆出來給一個專職的小型 AI：

```
使用者發送訊息 → P1 檢索 AI（<5K token，專注找）→ 精選記憶 + 目前對話 → 回覆 AI（專注回覆）
```

BM25 粗篩 + 正規表達式精確比對，最多 3 輪命中。檢索用免費輕量模型即可，每次對話實際開銷 ≈ 只有回覆 AI 一次呼叫的成本。P1 同時負責預設自動切換（冷卻 5 輪防振盪）。

</details>

<details>
<summary><strong>🗜️ 上下文管理 — 壓縮粒度 × 層級 × AI 自主清理</strong></summary>

AI 工作時會不斷堆積過程性內容（反覆讀同一個檔案、過時的搜尋結果、舊的工具結果）。我們的清理只是隱藏——隨時可復原。

**AI 自主清理**：系統注入上下文佔用訊號（50% 建議 / 70% 警告 / 85% 緊急），AI 用 `<contextClean>` 指令自主瘦身。清理前先落盤，清錯也能還原。

**使用者精細管理**：三級層次（一鍵全量/依類型/逐條精挑）× 四類粒度（對話訊息/檔案讀取逐條 token 帳單/系統注入五類勾選/過程內容自動瘦身）。

快取率實測（Opus + DeepSeek，含 AI 身份切換 + 自主壓縮）：**75%–80%**。

![壓縮面板](imgs/screenshots/compression-multi.png)

</details>

<details>
<summary><strong>🔬 自驅動 P1 — 正在優化中的零 LLM 檢索引擎</strong></summary>

AI P1 每輪都要發 API 請求——有延遲、有成本、離線不能用。我們寫了一條完整的純演算法管線（21 節點，約 9,000 行），目標：毫秒級、零網路、句子級注意力。

**資料基礎**：[SWOW 中文聯想網路](https://smallworldofwords.org/) / [ConceptNet Numberbatch 300 維詞向量](https://github.com/commonsense/conceptnet-numberbatch)（約 30 萬詞）/ ConceptNet 中文關係圖 / THUOCL 等多來源詞典。詞庫由 AI 上網搜尋 + 2 天自我審查取得，建置成本近乎為零。

**管線**：斷詞 → SWOW 聯想發散（禁止同義詞擴散，實測啟用會讓品質下降 55–76%）→ 六軸並行評分（心理/資訊/社會/邏輯/語言/認知）→ 47 個子方向定位 → 多資源交叉確認 → 空間投票排名（加性 IDW，非連乘）→ 二次發散（5 條獨立路徑）→ BLQ 評分（參照 CombSUM 加性融合，自研維度權重）→ 方向詞選擇 → 注入上下文。21 個節點全部純演算法，零 LLM。

**實驗**：27 個版本迭代，發散評分 v9→v26 從 2.01 提升到 4.05（+101%，滿分 5，人工逐詞判定）；召回命中率 約 90%；綜合平均約 3.5 分。萬用詞比率從 74% 降到 4%。

**真實輸出**（200 個案例批次執行原始記錄）：

| 使用者輸入 | 系統發散方向 | 跨到的學科 |
| --- | --- | --- |
| 「快撐不下去了，活著怎麼這麼難？」 | 當下覺察 / 內感受覺知 / **實在的本質是什麼** | 心理學 → **存在主義哲學** |
| 「準備獨角獸公司面試，怎麼準備有深度的問題？」 | 根本原因分析 / **最近發展區** | 管理學 → **教育心理學** |
| 「有限預算下私域流量經營挽回流失使用者」 | **預設模式網路活化** / **BDNF 腦源性神經滋養因子** | 行銷 → **認知神經科學** |
| 「資料庫查詢特別慢怎麼優化」 | 不可變性與狀態更新 / **SRP** | 維運 → **軟體工程方法論** |
| 「劍客在雪山遇到敵人的故事」 | **契訶夫之槍** / 榮格原型 | 故事 → **敘事學 + 分析心理學** |
| 使用者原創詩「我死在光來臨前」 | **可能世界與平行宇宙** | 詩歌 → **物理學多世界詮釋** |

詞庫准入標準：**主模型光讀也能推出來的詞就是廢詞**——P1 的價值在於給模型牠自己想不到的方向。

</details>

<details>
<summary><strong>👑 提示詞引擎 + 世界書動態注入</strong></summary>

**TweakPrompt 三輪**統一接管所有模組輸出：Round 1 收集 → Round 2 重建 5 段式訊息結構（beforeChat / injectionAbove / chatHistory / injectionBelow / afterChat）+ 巨集替換 → Round 3 快照。

**世界書 3 種啟用模式**：常駐（每輪注入）/ 正規表達式（關鍵字觸發）/ 動態（讀取記憶表格數值條件觸發——好感度 > 80 解鎖特殊對話、任務進度到第三章切換世界觀描述）。

**巨集系統**：`{{char}}` / `{{user}}` / `{{tableData}}` / `{{hotMemory}}` / `{{current_date}}` / `{{time}}` / `{{idle_duration}}` + 自訂巨集。

</details>

<details>
<summary><strong>🏗️ 系統架構</strong></summary>

三層：**功能層**（記憶/壓縮/召回/預設/世界書/連網/檔案操作……全域一份）→ **傳導層**（每個視窗各自拉線，用 id 隔離，天然非同步互不打擾）→ **介面層**（網頁/Bot/桌寵/VSCode 擴充套件，換介面不換能力）。

資料隔離：使用者級（AI 來源/全域設定）/ 角色卡級（記憶/對話/世界書/正規表達式）/ 對話級（聊天紀錄/模式/子模式）。

22 個外掛依統一規範生長，MCP 接外部工具，使用者級外掛宿主掛載 Python/Node 程式——擴充不改本體程式碼。

</details>

<details>
<summary><strong>🔭 關於大視窗時代</strong></summary>

即使視窗擴大到 10M+ token，我們依然保留分層記憶：①上下文利用率隨長度衰減有充分實驗證據；②約 10K token 精選記憶承載 100K+ 歷史資訊量，成本差一個數量級；③結構化表格比散落對話更容易被 AI 準確讀寫。

</details>

---

## 路線圖

**已完成**：三層記憶 · 壓縮系統 · P1 檢索 · 提示詞引擎 · 預設自動切換 · 記憶表格 · 世界書動態注入 · Live2D 桌寵 · 遊戲陪伴 · 語音輸入 · AI 製作簡報 · MCP · 多視窗並行 · VSCode 擴充套件橋接 · Discord Bot · 22 外掛 · 資源回收桶與備份回檔 · 全端診斷 · 多語言

**近期計畫**：自驅動 P1（純演算法，零 LLM，句子級注意力）· 更多 Bot 平台 · 外掛生態 · TTS / 文字生圖 · AI 遊戲引擎（era 系血統，數值確定性程式碼+LLM 敘事+符號渲染）· 直播模式

---

## 技術堆疊

執行環境 fount（Deno）· 後端 Node.js 相容層 + Express 路由 · 前端原生 JS（ESM）· 智慧檢索 BM25+正規表達式（純 JS 零相依）· 桌寵 Electron · 語音本機轉錄模型 · 跨平台 discord.js v14 · 儲存純 JSON

---

## 社群

<a href="https://discord.gg/agHeDq9bqU"><img src="https://img.shields.io/badge/Discord-立即加入-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord"></a>

[📦 開箱即用的記憶預設](beilu-presets_2026-02-23.json) — 匯入即用

分享角色卡 · 發布預設 · 貢獻世界書 · 回報 Bug · 提出建議 · 貢獻程式碼 — 歡迎參與！

---

## 使用的技術與資源

- **語音轉錄**：[MOSS-Transcribe-Diarize](https://huggingface.co/ICTNLP/MOSS-Transcribe-Diarize)（本機部署，具講者區分，模型約 1.8GB 首次使用時自動下載）
- **詞向量**：[ConceptNet Numberbatch](https://github.com/commonsense/conceptnet-numberbatch)（Speer & Lowry-Duda, 2017）
- **聯想資料**：[SWOW（Small World of Words）](https://smallworldofwords.org/)中文聯想資料集
- **斷詞與詞典**：THUOCL / CoreNatureDictionary / Chinese-Synonyms 等公開資源
- **搜尋引擎橋接**：[ddgs](https://pypi.org/project/ddgs/)（Python TLS 指紋層，解決裸 fetch 被搜尋引擎降級的問題）

## 致謝

- **[fount](https://github.com/steve02081504/fount)** — 專案初期的基礎框架，提供了 AI 訊息收發、服務來源管理、模組載入等核心基礎設施的初期參考。雖然專案現在已在架構上完全獨立演化，但 fount 在早期為我們節省了大量底層開發時間，提供了許多寶貴的想法參考，對此非常感謝
- **[SillyTavern](https://github.com/SillyTavern/SillyTavern)** — AI 角色扮演領域的先驅專案，其預設格式、角色卡規範和世界書系統已成為社群標準，本專案完全相容其生態
- **SillyTavern 外掛社群** — 感謝所有開源外掛作者在渲染引擎、功能擴充等方面的探索與分享

---

<details>
<summary><strong>📸 更多功能截圖（點開檢視）</strong></summary>

| | | |
|---|---|---|
| ![PPT詳情](imgs/screenshots/ppt-detail.png) **PPT 全流程** | ![安全設定](imgs/screenshots/security-settings.png) **安全與任務流程** | ![安全中心](imgs/screenshots/security-center.png) **安全防護中心** |
| ![多語言](imgs/screenshots/i18n-support.png) **多語言支援** | ![CSS主題](imgs/screenshots/css-themes.png) **多套主題** | ![wiki](imgs/screenshots/wiki-guide.png) **內建 Wiki** |
| ![子模式](imgs/screenshots/sub-mode-agent.png) **子模式工作流程** | ![選單](imgs/screenshots/hamburger-menu.png) **上下文速覽** | ![loop](imgs/screenshots/auto-loop.png) **自動/定時 Loop** |
| ![工具偵測](imgs/screenshots/tool-detection.png) **環境偵測** | ![記憶層](imgs/screenshots/memory-data-layers.png) **記憶檔案結構** | ![擴充](imgs/screenshots/browser-automation.png) **瀏覽器自動化** |
| ![外部介面](imgs/screenshots/external-interface.png) **外部介面** | ![Bot](imgs/screenshots/discord-bot-mode.png) **Discord Bot** | |

</details>

---

## 授權條款

本專案基於 [fount](https://github.com/steve02081504/fount) 框架開發，已與原作者直接溝通並取得授權使用。

<p align="center">
  <img src="imgs/icon.jpg" alt="always accompany" width="200">
</p>

<h1 align="center">always accompany</h1>

<p align="center">
  <a href="https://discord.gg/agHeDq9bqU"><img src="https://img.shields.io/badge/Discord-加入社群-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord"></a>
  &nbsp;
  <a href="https://github.com/beilusaiying/always-accompany"><img src="https://img.shields.io/badge/GitHub-點個_Star_⭐-181717?style=for-the-badge&logo=github" alt="GitHub"></a>
</p>

<p align="center"><a href="README.md">English</a> | <a href="README_CN.md">簡體中文</a> | 繁體中文 | <a href="README_JA.md">日本語</a> | <a href="README_DE.md">Deutsch</a> | <a href="README_ES.md">Español</a></p>

<p align="center">📖 <a href="https://beilusaiying.github.io/always-accompany/">線上 Wiki 使用指南</a> &nbsp;·&nbsp; 📄 <a href="docs/p1-paper/README.md">P1 技術論文</a></p>

> 本專案由一名剛畢業的大學生獨立完成全部設計、架構與開發，藉助 AI 輔助程式設計，融合演算法設計、仿生學原理、框架架構和邏輯思維等多方面能力。

---

```bash
git clone https://github.com/beilusaiying/always-accompany.git
cd always-accompany
run.bat          # Windows
# 或 chmod +x run.sh && ./run.sh   # Linux/macOS
```

瀏覽器開啟 `http://localhost:1314` → 設定 AI 服務來源 → 匯入角色卡 → 開聊。Deno 執行環境會在首次啟動時自動下載，無需手動安裝。至少需要一個 AI API Key。應用程式內建完整 wiki 教學，也可以直接看[線上 Wiki](https://beilusaiying.github.io/always-accompany/)。

> **提示：** 首次啟動會比較慢——執行環境需要下載相依套件並初始化資料庫，請等待頁面完全載入後再操作。之後的啟動會快很多。

---

## 為什麼會有這個專案

或許你看過《底特律：變人》，或許看過《可塑性記憶》。裡面的人形 AI 很聰明，工作和陪伴融為一體。所以——我打算給自己也做一個。

**第一個要解決的問題是記憶。**

現在的 AI 上下文動輒百萬 token，記憶儲存工具和壓縮工具也很多。但要嘛太平面，要嘛越到後期堆的東西越多。你不想讓你的 AI 伴侶忘記你們之間的記憶，但按現有方案，這幾乎不可能。

那麼，記憶到底是什麼？人的記憶其實很短暫——兩天前的細節基本就模糊了。但給一個關鍵詞，馬上就能想起對應的、或者相關的記憶。這引出兩個方向：**記憶怎麼存，記憶怎麼找。**

人不會記住每個細節，會選擇性遺忘；但現在的 AI 不會——要嘛暴力壓縮，要嘛塞進向量庫。這違背了記憶的本性：你不可能馬上忘記最近發生的事，也不可能每天把這幾年做過的事都想一遍。

於是我們照著這個思路，做了下面這套東西。

---

## 記憶系統 — 像人一樣存，像人一樣忘

> 📖 詳細圖文教學：[線上 Wiki · 記憶系統](https://beilusaiying.github.io/always-accompany/#zh-TW/memory/overview.md)

**data 表格**存當天的記憶和永久的記憶——就像你可能永遠記得初戀的名字、記得第一件事、記得告白那天。

往上是按時間距離分的三層，模擬人的選擇性遺忘（記憶形成的分層機制 + 艾賓浩斯遺忘曲線）：

```
📋 data 表格 — 當天記憶 + 永久記憶（chat / code / work 各自獨立）
🔥 熱層（按週）— 每天的 data 自動歸檔，AI 按時間、事件、流程歸檔
🌤️ 溫層（按月）— 二次壓縮、提取關鍵詞，像一本目錄
❄️ 冷層（按年）— 深度歸檔，檢索命中時依然可達
```

**注入權重按層級遞減**：上下文 > data（永久記憶、輪迴條目）> 熱層 > 溫層 > 冷層，同時做 top-k——按最近召回情況在每個層級內二次排序，層級之間還有緩衝層。一個完整的模擬記憶召回層 + 一個動態層。

按 AI 錄入 data 的實際情況和每天的歸檔優化推導，執行一年後每輪注入依然小於 1 萬 token（推導值：按一條 data 條目 ≈20 字元、每天 100 次互動、每日 AI 總結優化估算；熱層實測每輪 ~7,000–11,000 tokens）。除了少數難點，這套東西**純提示詞 + 純 JSON 文件驅動**——改歸檔策略、表格含義、檢索風格，改提示詞就行。儲存成本≈0。

長上下文不是解藥：實驗證據（[Lost in the Middle](https://arxiv.org/abs/2307.03172) / [RULER](https://arxiv.org/abs/2404.06654) / [NoLiMa](https://arxiv.org/abs/2502.05167)）表明上下文利用率隨長度和位置衰減——都塞進去 ≠ 都看得到。~1 萬 token 的精選記憶，承載的是 10 萬+ token 歷史的資訊量。

熱層還可以掛文件和相關記憶——比如角色扮演裡的裝備、其他角色參數。

---

## 記憶召回 — 不是檢索，是發散 + 檢索

> 📄 完整演算法與實驗：[P1 技術論文](docs/p1-paper/README.md) · 📖 [線上 Wiki · P1 專項](https://beilusaiying.github.io/always-accompany/#zh-TW/p1-recall/preface.md)

「給一個關鍵詞馬上想起相關記憶」——這不是簡單的關鍵詞檢索。認知心理學的結論是：人的記憶是一張語義網路，一個概念被激活後沿關聯邊向鄰居擴散、越遠越弱（擴散激活理論，Collins & Loftus 1975）；「醫生」出現後識別「護士」更快（啟動效應，Meyer & Schvaneveldt 1971）。人的召回瞬時性極強，同時會控制深度和廣度（工作記憶容量 4±1 組塊，Cowan 2001）。

對照現有方案：簡單檢索做不到廣度；讓一個輔助 AI 來，牠需要先發散再找，做不到瞬時性；而且記憶越多，開銷越大。

**目前生產方案（AI P1）**：一個專職檢索 AI 先找記憶，只把找到的交給回覆 AI——各管各的，注意力不稀釋。BM25 粗篩 + 正規表達式精確比對，檢索可用免費輕量模型。

**正在優化的下一代（自驅動 P1）**：一條完整的純演算法管線，零 LLM、零網路：

```
使用者對話 + 最近 5 輪上下文 + data
  → 斷詞（BCC 語料，排除「他的/這樣」等常用詞）
  → SWOW 聯想發散 + NB300 六度發散模式 ×2（work 模式追加領域資源庫）
  → 六軸定位（心理/資訊/社會/邏輯/語言/認知）→ 47 子軸方向細化 → 溫度畫圓控制召回半徑
  → 空間投票（IDW 加權多對一累加）→ BLQ 打分 → 召回 + 方向詞注入
```

六軸給粗定位（詞落在哪個學科方向），47 子軸刻畫粗定位內部沿各細分方向的語義變化率——角色類似李導數（沿指定方向求變化率）；一條軸對一個詞的定位產出是**多個資訊點**而非一個分數（概念在語義空間裡占的是區域不是點，Gärdenfors 概念空間理論 2000）。6 軸 → 47 子軸 → 資源庫（SWOW / ConceptNet / Numberbatch 30 萬詞向量 / 情感與領域詞庫）構成多層互聯結構：激活按層級傳導、加性匯聚——類資源庫 + 神經網路的結構。

BLQ 打分是加性融合（參照 CombSUM，Fox & Shaw 1994）：6 個證據維相加、4 個罰項相減——相加是 OR 門，證據互補；相乘是 AND 門，一個 0.3 就把全鏈拉崩。

**實測**：消費級配置（8GB 顯存 + 32GB 記憶體）約 200ms 一次完整召回——每次對話都有一個龐大的瞬時記憶在背後支撐。27 個版本迭代，發散品質評分 +100% 以上，萬金油率 74%→4%。實驗數據全部公開在 [Wiki P1 專項](https://beilusaiying.github.io/always-accompany/#zh-TW/p1-recall/ch5-evolution.md)和[論文第六章](docs/p1-paper/zh/06_实验与评估.md)。

---

## 發散 — 給 AI 牠自己想不到的方向

神經網路和注意力機制天生是**收攏**的：AI 看一大堆記憶再想現在的事，效果差、容易過擬合。所以我們做了**外部發散**：每次注入 100 token 以下的方向性內容——都是過擬合的 AI 自己想不出來的方向。少量方向詞就能顯著引導生成方向（方向性刺激提示 DSP，NeurIPS 2023）；外部機構負責發散、LLM 負責收斂，優於 LLM 自發散（外部鷹架研究 2025）。

**相關性發散**——你在坐車，突發奇想想拉開車門。電影裡的場景是主角翻滾、受點擦傷；但你的安全教育告訴你這可能喪命。你開始想：為什麼電影這麼拍？——心理學、視覺表現、影視學。為什麼會喪命？——物理學、生物學。這麼短的時間，你跨了這麼多學科。創造性聯想恰好存在於「不太近、不太遠」的最優語義距離帶（遠程聯想理論 Mednick 1962；Orwig et al. 2025）。

**框架性發散**——兩個完全不同的領域，功能和流程差不多，就可以建立聯繫：工廠流水線和 Agent，都是樣本→穩定→模組化產出（結構映射理論，Gentner 1983）。

真實輸出（200 例批次執行原始記錄）：

| 使用者輸入 | 系統發散方向 | 跨到的學科 |
| --- | --- | --- |
| 「快撐不下去了，活著怎麼這麼難？」 | 當下覺察 / **實在的本質是什麼** | 心理學 → **存在主義哲學** |
| 「準備獨角獸公司面試，怎麼準備有深度的問題？」 | 根本原因分析 / **最近發展區** | 管理學 → **教育心理學** |
| 「資料庫查詢特別慢怎麼優化」 | 不可變性與狀態更新 / **SRP** | 維運 → **軟體工程方法論** |
| 「劍客在雪山遇到敵人的故事」 | **契訶夫之槍** / 榮格原型 | 故事 → **敘事學 + 分析心理學** |
| 使用者原創詩「我死在光來臨前」 | **可能世界與平行宇宙** | 詩歌 → **物理學多世界詮釋** |

詞庫准入標準：**主模型裸讀也能推出的詞即廢詞**——發散要解決的就是兩件事：過擬合，和 AI 的發散釋放。

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

- **🧠 三層記憶**：熱（每輪注入）/ 溫（按需檢索）/ 冷（深度歸檔），純 JSON + 純提示詞驅動，零資料庫 → [Wiki](https://beilusaiying.github.io/always-accompany/#zh-TW/memory/overview.md)
- **🎯 P1 前置檢索**：專職小型 AI 先找記憶再交給回覆 AI，BM25 + 正規表達式雙引擎，檢索可用免費模型
- **🗜️ 壓縮系統**：三級層級 × 四類顆粒度 + AI 自主清理，全部可回溯 → [Wiki](https://beilusaiying.github.io/always-accompany/#zh-TW/memory/compression.md)
- **📊 10 張記憶表格**：結構化儲存，AI 用 `<tableEdit>` 自動維護，資訊隔離（角色不知道的事表格裡就沒有）
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
<summary><strong>🗜️ 壓縮 — 顆粒度細到每一個檔案</strong></summary>

說實話，我不知道為什麼沒有人做細化的壓縮分類——尤其是程式碼場景，大都是暴力壓縮和一鍵隱藏。

透過調查：AI 的上下文堆積主要來自反覆讀取的檔案、thinking 和工具回饋。所以我們做了完整的壓縮機制，顆粒度極其細緻：

- **檔案級別**——AI 讀取的每一個檔案，逐條 token 帳單
- **工作級別**——thinking 和工具回饋每個輪迴自動刪除
- **上下文級別**——對話、分身注入、AI 讀取分別管理，還可以只隱藏 AI 的話、保留使用者的話

**你的資訊 = 0 流失**：所有「清理」都只是不再傳送，原文留在硬碟上隨時復原。加上提示詞鼓勵 MD 落盤，IDE 模式下 100MB 級的大型專案裡，AI 依然能看到你的第一句話——這直接減少 AI 的「任務屬性替換」問題（做著做著忘了最初要幹什麼）。

AI 還有自主壓縮能力：系統注入佔用訊號（50% 建議 / 70% 警告 / 85% 緊急），AI 用 `<contextClean>` 自己決定哪些檔案不要了。

快取效率實測（Opus + DeepSeek 渠道，含 AI 身份切換 + 自主壓縮）：**70%–80%**。

→ [Wiki · 上下文壓縮](https://beilusaiying.github.io/always-accompany/#zh-TW/memory/compression.md)

</details>

<details>
<summary><strong>🛡️ 安全與隱私</strong></summary>

考慮到公司級部署場景：CC 攻擊、DDoS、Slowloris 的防護。

個人隱私側：AI 可存取網站白名單（預設空白，安全預設拒外）、輸出內容屏蔽（尤其跨平台協作功能）、AI 截圖限制、L0–L5 六檔權限閘、指令執行逐條審核。資料全部本機，音訊不出機器。

</details>

<details>
<summary><strong>🏗️ 架構 — 核心功能外掛化，擴充不改本體</strong></summary>

後端把核心功能做成外掛，中間是一個資訊站（傳導層），前端只做展示 + 操作：

```
AIRP ─→ 輸入/快取/處理（隔離）─┐
Code ─→ 輸入/快取/處理（隔離）─┤→ 資訊站（傳導層）→ 前端展示
Work ─→ 輸入/快取/處理（隔離）─┘
```

所以擴充性很強：要加功能，直接做個擴充套件，支援 JS / Python 等。

**隔離級別**：
- **視窗級**——code、work、chat、airp、遊戲陪伴、bot 各自隔離（遊戲陪伴寫入 chat 的 data）
- **角色卡級**——data、記憶、對話檔案、正規表達式按角色卡隔離
- **細粒度**——世界書、預設
- **使用者級**——各種設定、角色卡
- **chatid**——同一模式開多視窗專用（code 多視窗 / bot），是為多視窗服務的獨立隔離維度

三層：**功能層**（記憶/壓縮/召回/預設/世界書/連網/檔案操作，全域一份）→ **傳導層**（每視窗各自拉線，id 隔離，天然非同步）→ **介面層**（網頁/Bot/桌寵/VSCode 擴充套件，換介面不換能力）。

</details>

<details>
<summary><strong>👑 提示詞引擎 + 世界書動態注入</strong></summary>

**TweakPrompt 三輪**統一接管所有模組輸出：Round 1 收集 → Round 2 重建 5 段式訊息結構（beforeChat / injectionAbove / chatHistory / injectionBelow / afterChat）+ 巨集替換 → Round 3 快照。

**世界書 3 種啟用模式**：常駐（每輪注入）/ 正規表達式（關鍵字觸發）/ 動態（讀取記憶表格數值條件觸發——好感度 > 80 解鎖特殊對話、任務進度到第三章切換世界觀描述）。

**巨集系統**：`{{char}}` / `{{user}}` / `{{tableData}}` / `{{hotMemory}}` / `{{current_date}}` / `{{time}}` / `{{idle_duration}}` + 自訂巨集。

→ [Wiki · 世界書與注入](https://beilusaiying.github.io/always-accompany/#zh-TW/memory/worldbook-overview.md)

</details>

<details>
<summary><strong>🔭 關於大視窗時代</strong></summary>

即使視窗擴大到 10M+ tokens，我們依然保留分層記憶：①上下文利用率隨長度衰減有充分實驗證據；②~10K tokens 精選記憶承載 100K+ 歷史資訊量，成本差一個數量級；③結構化表格比散落對話更易被 AI 準確讀寫。

</details>

---

## 我們現在可以做什麼

使用者錄音轉文字（記錄時間軸、人物）· AI 製作簡報 · IDE（工具鏈可對比主流程式設計 Agent）· AIRP 全套（SillyTavern 生態對齊、渲染、MVU、世界書、動態上下文機制）· Live2D 桌寵、截圖優化、遊戲陪伴 · Discord Bot……

也就是說——**一個可以永遠陪伴你的、和你一起工作的朋友，或者戀人。可以陪你去異世界冒險，可以幫你工作。**

再往後？自驅動系列做出來，就是快速傳導的、永久記憶的 AI：投放到遊戲產業是遊戲陪伴；投到工作或醫療，就是長期記憶 + 隨時可用的分析與狀態記錄 + 相同情況下的快速應對。最初的構想其實是真正的人形智慧——本機的小型模型負責感測器模組，主智能體透過網路傳導。這套記憶系統就是為那一天準備的。

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

分享角色卡 · 發布預設 · 貢獻世界書 · 回報 Bug · 提出建議 · 貢獻程式碼 — 歡迎參與！

---

## 使用的技術與資源

- **語音轉錄**：[MOSS-Transcribe-Diarize](https://huggingface.co/OpenMOSS-Team/MOSS-Transcribe-Diarize)（本機部署，具講者區分，模型約 1.8GB 首次使用時自動下載）
- **詞向量**：[ConceptNet Numberbatch](https://github.com/commonsense/conceptnet-numberbatch)（Speer & Lowry-Duda, 2017）
- **聯想資料**：[SWOW（Small World of Words）](https://smallworldofwords.org/)中文聯想資料集
- **斷詞與詞典**：BCC 語料 / THUOCL / CoreNatureDictionary / Chinese-Synonyms 等公開資源
- **搜尋引擎橋接**：[ddgs](https://pypi.org/project/ddgs/)（Python TLS 指紋層，解決裸 fetch 被搜尋引擎降級的問題）

理論參照（完整 56 條見[論文第一章](docs/p1-paper/zh/01_引言与相关工作.md)）：擴散激活（Collins & Loftus 1975）· 啟動效應（Meyer & Schvaneveldt 1971）· 遠程聯想（Mednick 1962）· SWOW（De Deyne et al. 2019）· 概念空間（Gärdenfors 2000）· CombSUM（Fox & Shaw 1994）· BM25（Robertson et al. 1995）· IDW（Shepard 1968）· Hough 投票（Hough 1962）· RRF（Cormack et al. 2009）

## 致謝

- **[fount](https://github.com/steve02081504/fount)** — 專案初期的基礎框架，提供了 AI 訊息收發、服務來源管理、模組載入等核心基礎設施的初始參考。雖然專案現在已經在架構上完全獨立演化，但 fount 在早期為我們節省了大量底層開發時間，提供了許多寶貴的想法參考，對此非常感謝
- **[SillyTavern](https://github.com/SillyTavern/SillyTavern)** — AI 角色扮演領域的先驅專案，其預設格式、角色卡規範和世界書系統已成為社群標準，本專案完全相容其生態
- **SillyTavern 外掛社群** — 感謝所有開源外掛作者在渲染引擎、功能擴充等方面的探索和分享

---

<details>
<summary><strong>📸 更多功能截圖（點開看）</strong></summary>

| | | |
|---|---|---|
| ![PPT詳細](imgs/screenshots/ppt-detail.png) **PPT 全流程** | ![安全設定](imgs/screenshots/security-settings.png) **安全與任務流程** | ![安全中心](imgs/screenshots/security-center.png) **安全防護中心** |
| ![多語言](imgs/screenshots/i18n-support.png) **多語言支援** | ![CSS主題](imgs/screenshots/css-themes.png) **多套主題** | ![wiki](imgs/screenshots/wiki-guide.png) **內建 Wiki** |
| ![子模式](imgs/screenshots/sub-mode-agent.png) **子模式工作流程** | ![選單](imgs/screenshots/hamburger-menu.png) **上下文速覽** | ![loop](imgs/screenshots/auto-loop.png) **自動/定時 Loop** |
| ![工具檢測](imgs/screenshots/tool-detection.png) **環境檢測** | ![記憶層](imgs/screenshots/memory-data-layers.png) **記憶檔案結構** | ![擴充](imgs/screenshots/browser-automation.png) **瀏覽器自動化** |
| ![外部介面](imgs/screenshots/external-interface.png) **外部介面** | ![Bot](imgs/screenshots/discord-bot-mode.png) **Discord Bot** | |

</details>

---

## 連結

- 📖 線上 Wiki（使用指南 + P1 專項 + 實驗數據）：https://beilusaiying.github.io/always-accompany/
- 📄 P1 技術論文（中英各 7 章）：[docs/p1-paper](docs/p1-paper/README.md)
- 💬 Discord 社群：https://discord.gg/agHeDq9bqU

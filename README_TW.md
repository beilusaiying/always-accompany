<p align="center">
  <img src="imgs/icon.jpg" alt="always-accompany" width="180">
</p>

<h1 align="center">always-accompany</h1>

<p align="center"><strong>一個專注於上下文與注意力機制的多元 AI + Agent 專案</strong></p>

<p align="center">陪伴、聊天、程式設計、工作共用同一套記憶與上下文框架——像科幻作品裡那種 AI，陪你、也幫你做事。</p>

<p align="center"><strong>動態注意 · 固定注入 · 專案隔離 · 專項模式</strong></p>

<p align="center">
  <a href="https://discord.gg/agHeDq9bqU"><img src="https://img.shields.io/badge/Discord-加入社区-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord"></a>
  &nbsp;
  <a href="https://github.com/beilusaiying/always-accompany"><img src="https://img.shields.io/badge/GitHub-点个_Star_⭐-181717?style=for-the-badge&logo=github" alt="GitHub"></a>
</p>

<p align="center"><a href="README.md">English</a> · <a href="README_CN.md">简体中文</a> · 繁體中文 · <a href="README_JA.md">日本語</a> · <a href="README_KO.md">한국어</a> · <a href="README_RU.md">Русский</a> · <a href="README_DE.md">Deutsch</a> · <a href="README_ES.md">Español</a> · <a href="README_FR.md">Français</a> · <a href="README_PT.md">Português</a></p>

> [!NOTE]
> **開發說明：**本專案主體由一人在約三個月內完成，之後再用約一個月集中優化演算法。由於開發週期短、功能範圍大，目前的工程結構、基礎功能與邊界處理仍可能不穩定或尚未完善。部分基礎功能由 AI 輔助實作，複雜功能的框架、演算法與關鍵設計則由作者本人規劃和指導，因此各模組的成熟度並不完全一致。後續將持續進行人工複核、微調與工程化優化；若遇到 Bug，歡迎提供重現步驟與日誌。
>
> **後續計畫：**停止增加新的外掛與功能板塊，將工作重心轉向精簡核心、降低耦合，並逐步把可拆分的功能移到外掛層。專案會補齊詳細且穩定的外掛協定，之後進行框架工程級優化與漸進式重構，同時完善測試、文件與貢獻流程，讓更多開發者能理解、擴充並參與本專案。

---

## 它可以直接做什麼？

- 進行長期聊天和角色扮演，可直接匯入 SillyTavern 的角色卡、預設、世界書等社群格式；
- 像本機 Agent 工作台一樣讀取與修改專案檔案、執行命令；
- 透過 Live2D / 圖片桌寵、螢幕感知、遊戲陪伴、語音輸入，以及涵蓋 9 個平台的 Bot 系統延伸到瀏覽器之外；
- 把長期材料儲存在本機檔案中，每一輪自動找出與目前問題相關的片段，並讓不再需要的舊上下文退出；
- 編輯角色、提示詞內容與順序、注入身份與位置、條件觸發規則、記憶召回路線、權限和外掛，把它改造成自己的 AI。

**我們有什麼？** 這些介面背後是同一套系統，真正的不同集中在四件事：

- **獨特的記憶與上下文框架** — Data + hot / warm / cold 分層儲存長期材料，一個收集上下文、檢索記憶的工具（P1）在每輪回答前召回目前相關的片段；上下文清理做到檔案讀取級顆粒度、可逆，AI 也能自行放棄不再需要的已讀檔案（作者環境按計費口徑實測快取效率約 70–80%，非承諾值）；
- **全部內容可以編輯** — 角色、提示詞、注入、記憶、召回路線、權限與外掛都不是黑箱，想改哪一層都有入口；
- **一個高擴充的框架** — 核心功能以外掛組織，經中間資訊站傳導，前端只做展示與操作；使用者外掛可用 JS、Python 或獨立程式撰寫；
- **一個 agent 有的全部功能** — 檔案、命令、瀏覽器、MCP、多視窗、審批與恢復齊備，並共用同一套記憶與上下文框架；它為完成大型專案而生，核心就是把有限的注意力用在刀口上。

---

## 快速開始

只需要兩樣東西：

- 一個可用的 AI API；
- 會寫簡單的提示詞。

有這兩樣就能馬上上手體驗。要提前說明的是：目前 AIRP 和 Chat 的提示詞我們還在細做——現階段以生產力為主，陪伴向的打磨會逐步補上。

如果你只想開始聊天，這就是全部成本。自驅動 P1 的本機檢索服務（目前實測峰值記憶體約 2 GiB 量級）可以整體關閉；P1 參數、提示詞注入位置、Code、Work 與外掛都屬於按需深入的設定，不是第一次使用的前置課程。

```bash
git clone https://github.com/beilusaiying/always-accompany.git
cd always-accompany
run.bat          # Windows
# 或 chmod +x run.sh && ./run.sh   # Linux / macOS
```

啟動器會在缺少 Deno 時自動下載執行環境，並在相依不完整時完成安裝。頁面就緒後瀏覽器通常會自動開啟；也可以手動存取 `http://localhost:1314`。

| 1. 選擇介面語言 | 2. 綁定 AI 服務來源 |
|---|---|
| ![選擇語言](imgs/screenshots/onboarding-language.png) | ![綁定 API](imgs/screenshots/onboarding-api.png) |

填入服務位址、API Key 和模型，儲存後選擇或匯入一張角色卡，就能開始聊天。至少需要一個可用的 AI API；模型能力與費用取決於你綁定的服務。應用程式內建[完整 Wiki](site/wiki/getting-started/overview.md)，也可存取[線上版](https://beilusaiying.github.io/always-accompany/)。

> 首次啟動通常更久：執行環境需要下載相依並初始化本機資料。請等頁面完整出現後再操作；後續啟動會更快。語音、桌寵等可選能力可能還有自己的首次下載或環境需求。

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
![IDE 程式設計](imgs/screenshots/ide-coding.png)

</td>
<td width="33%">

**📊 Work 模式與 PPT**
![Work 模式 PPT](imgs/screenshots/work-ppt-mode.png)

</td>
</tr>
<tr>
<td width="33%">

**🐾 Live2D 桌寵 + 螢幕感知**
![桌寵](imgs/screenshots/live2d-pet-mode.png)

</td>
<td width="33%">

**🔒 六檔權限範本 + 逐工具規則**
![權限設定](imgs/screenshots/ai-permissions.png)

</td>
<td width="33%">

**🗜️ 分層壓縮 × 逐條可控**
![壓縮機制](imgs/screenshots/compression-detail.png)

</td>
</tr>
</table>

- **🧭 四大主模式 + 輔助檢視**：Smart 全智能、Chat 聊天 / 角色扮演、Code 程式設計、Work 工作各有獨立記憶表與 P1 路線；另有 Bot 管理、遊戲陪伴、記憶管理、ST 適配等輔助檢視；
- **🧠 Data（可編輯的結構化記憶表）+ 三層記憶**：Data 與 `hot / warm / cold` 普通 JSON / MD 檔案分別承接目前事實、近期材料與歸檔；內容可檢視、可編輯；
- **🎯 P1（前置記憶召回）**：在主 AI 回答前，先從目前角色與模式允許讀取的長期材料中尋找相關片段。Chat / Code / Work 目前預設使用本機演算法路線；Smart / Bot 模式保留獨立 AI 檢索路線；兩條路線互斥，也可以關閉；
- **🗜️ 上下文管理**：按訊息、檔案讀取、工具結果和系統注入檢視佔用；普通清理只是把內容隱藏、不再發給 AI，記錄仍留在磁碟、可恢復；
- **📊 分模式記憶表**：Chat 有 #0–#9 表，Code 與 Work 使用自己的表和私有目錄，不把所有場景堆進同一張表；
- **👑 全部提示詞可編輯**：內容、順序、開關、system / user / assistant 身份、注入位置與條件都能調整；
- **💻 IDE 級工作流**：三欄版面、檔案讀取與編輯、命令執行、任務清單、多視窗與 VS Code 擴充橋；
- **🔌 MCP（外部工具連接協定）**：貼上 JSON 接入外部工具；命令型服務需經過 owner 和環境變數白名單等安全門；
- **🐾 桌寵與遊戲陪伴**：Live2D / 圖片包、三種螢幕感知方式、主動評論、獨立遊戲陪伴迴圈和自適應頻率；
- **🎙️ 本機語音輸入**：MOSS-Transcribe-Diarize 本機轉寫，支援說話人分離與時間戳；目前只做語音轉文字，不包含 AI 朗讀；
- **🤖 9 個平台 Bot**：目前原始碼包含 Discord、Telegram、Slack、LINE、飛書、釘釘、微信、企業微信和 X 平台殼；各平台仍需按自身要求設定 Token、Webhook 或第三方橋接；
- **🔎 可選語義向量檢索**：內建 beilu-vectordb（基於 Orama，支援全文 / 向量 / 混合搜尋），預設關閉，需自行設定 embedding 端點後開啟；與自驅動 P1 互補，而非二選一；
- **🧩 外掛系統**：目前原始碼有 23 個內建外掛目錄，新使用者範本預設列出 14 個；還可用 Python、Node 或獨立程式撰寫使用者外掛；
- **🛡️ 本機資料與恢復**：應用程式資料儲存在本機，支援隱藏恢復、回收與備份鏈；傳送給遠端 AI 或遠端 embedding 服務的內容仍受你所選服務的資料政策約束；
- **🌐 多語言 · 🔬 白盒診斷 · 🎨 多套主題**：核心中 / 英 / 日 / 繁介面之外還提供其他社群翻譯，部分低資源語言可能不完整。

---

## 我們到底打算解決什麼？

記憶儲存本身並不神秘。Data 是一份可寫表格，`hot / warm / cold` 說白了就是你按「時間 + 事件」建三個資料夾、往裡記 md；INJ（可編輯的提示詞注入條目）和預設也延續了 SillyTavern 等角色前端長期探索的提示詞編排方式。

但把它們組合起來，再加上 P1（一個收集上下文、檢索記憶的工具），就成了一套天然的「向量 + 動態注入 + 記憶跟著目前任務走」的生態——一個高注意力、高資訊密度的記憶庫；再搭配我們做到檔案級別的壓縮，整條鏈路就完整了。

其實一開始，我們打算把 P1 做成一個小 AI 單獨部署。但真正的問題出在儲存之後：記憶越積越大，如果每輪都要專門啟動第二個 AI 去翻，速度和花費還扛得住嗎？小 AI 真能找得全嗎？非得用付費 AI 不可嗎？會不會記得越多、反應越慢？

落到日常，就是幾個熟悉的場景：一個大專案，你讓 AI 先看鏈路、框架、MD 再給它任務，結果做到一半 token 就快滿了，一壓縮就得重看一遍——多個 agent 一起跑時，上下文更是災難；長任務裡 AI 反覆讀同一個只改了幾行的檔案，上下文越堆越爆，你卻刪不掉；有時你本想開一個新專案，AI 卻一頭錨定到之前舊專案的記憶上。

這些並非憑空假設：

- [Issue #6](https://github.com/beilusaiying/always-accompany/issues/6)
- [Codex #35226](https://github.com/openai/codex/issues/35226) · [Claude Code #34556](https://github.com/anthropics/claude-code/issues/34556)；
- [社群討論](https://www.reddit.com/r/SillyTavernAI/comments/1q7p33c/how_longterm_memory_works_in_sillytavernai/)；
- 網頁聊天產品的使用者也在提專案記憶的透明度和跨專案串擾問題：[檢索透明度請求](https://community.openai.com/t/feature-request-make-project-memory-transparent-searchable-and-user-controlled/1385159) · [專案專屬記憶請求](https://community.openai.com/t/project-specific-memory-in-chatgpt/1140856)。


### 儲存後，怎樣輸出給 AI

透過自研的 **P1 前置記憶召回**：它先圍繞使用者目前對話擴展檢索線索，再從目前角色與模式允許讀取的長期材料中找出相關原文，交給主 AI。可以把它理解為執行在模型外的動態注意機制——目前問題決定找什麼，長期材料提供候選，只有本輪選中的片段會進入回答。

在使用上這意味著：你不必複述原句，一句相關但不完全相同的話也可能把舊事帶回來；召回之後，介面會顯示本輪實際使用了哪些記憶——你驗證的是記錄本身，而不是 AI 的一句「我記得」。

---

## 詳細機制

<details>
<summary><strong>🧠 Data 與三層遞迴記憶 — 為什麼仍然要分層</strong></summary>

`hot / warm / cold` 首先是可讀寫的生命週期目錄，不是神秘資料庫：

```text
🔥 hot  — 近期、高頻、正在使用的材料
🌤️ warm — 階段性整理與歸檔材料
❄️ cold — 更長期的歷史材料
📊 Data — 目前模式下可編輯、可驗證的結構化事實
```

分層讓固定注入、按需召回和深層歸檔擁有不同成本與用途。原始材料留在普通 JSON / MD 中，使用者可以直接檢查和改正；P1 再決定這一輪從哪些層取回片段。

長上下文研究已經觀察到位置偏差與任務變複雜後的利用下降：[Lost in the Middle](https://aclanthology.org/2024.tacl-1.9/) · [RULER](https://arxiv.org/abs/2404.06654) · [Found in the Middle](https://aclanthology.org/2024.findings-acl.890/)。這些論文說明「能放進去」與「穩定用得到」不是同一件事，但不直接證明本專案方案更好。

</details>

<details>
<summary><strong>🗜️ 上下文管理 — 從整段壓縮到檔案讀取級清理</strong></summary>

AI 執行真實任務會產生大量過程內容：反覆讀取的檔案、舊工具結果、已經消費的指令標籤和過時訊息。always-accompany 同時提供自動壓縮、按類型清理和逐條選擇；預設清理使用 `_hidden` 標記，讓記錄留在磁碟，但不再傳送給 AI。

AI 也可以輸出 `<contextClean>` 請求清理；系統會保護使用者原話，並可設定最低 token 閾值，避免在上下文仍很小時頻繁破壞提示詞快取。永久或高風險操作不應與普通隱藏混用。

| 多層壓縮與顆粒度 | 檔案讀取級清理 |
|---|---|
| ![多層壓縮面板](imgs/screenshots/compression-multi.png) | ![檔案讀取級別的清理](imgs/screenshots/context-file-cleanup.png) |

普通使用者只需選擇不再需要的檔案讀取或訊息；想深入控制時，再檢視 token 帳單、類型、時間和來源。

</details>

<details>
<summary><strong>🔬 自驅動 P1 — 模型外的動態記憶注意鏈</strong></summary>

目前生產鏈是 Node0–4，而不是舊文件中的 21 節點描述：

```text
Node0  目前輸入 + 最近使用者訊息 + 目前模式 Data
  ↓
Node1  分詞、詞性、時間、專名與短語錨點
  ↓
Node2  SWOW / ConceptNet / 詞林 / ATOMIC / 領域詞等關聯擴展
  ↓
Node3  BLQ(自研演算法) / NB300 / WordNet 等多證據信號過濾
  ↓
Node4  回到 Data、hot / warm / cold 與模式記錄，結合 BM25、時間、層級、Top、importance 等排序
  ↓
recalledRecords + directionWords + trace
```

聯想詞不是記憶事實；候選必須回到真實記錄層才能成為最終召回結果。白盒面板會顯示輸入單元、各節點候選與刪除原因、索引狀態、最終來源和錯誤，便於判斷「沒召回」究竟是沒有匹配、資源降級還是鏈路失敗。

![自驅動 P1 白盒測試](imgs/screenshots/p1-self-driven-diagnostics.png)

白盒面板證明每個節點和真實來源都可以檢查；召回品質仍需要在同一語料、同一任務和帶標準答案的資料上評估。完整執行邊界見 [P1 目前生產合同](site/wiki/p1-recall/ch7-current-runtime.md)。

</details>

<details>
<summary><strong>👑 全部提示詞都能編輯 — 預設可用，也能繼續改造成自己的 AI</strong></summary>

角色設定、系統規則、模式說明、記憶資料槽和工具教學等提示詞條目都能在介面中編輯。每條內容都可以調整：

- 實際文字
- 先後順序
- 是否啟用
- 以 system、user 還是 assistant 身份傳送；
- 插入聊天歷史的哪個位置；
- 只在 Chat、Code、Work、Bot 或指定條件下生效。

</details>

<details>
<summary><strong>🔒 AI 能行動，但每種操作都有自己的邊界</strong></summary>

檔案寫入會按工具、路徑和三態規則得到 `deny / ask / allow`；命令還會經過黑名單、灰名單和遠端白名單；server 部署下的敏感設定與子程序能力需要 owner 開啟。

L0–L5 是一組從嚴控到全部放行的快捷範本，使用者還可以繼續細分到具體工具與路徑。L5 會跳過審批，是明確的高風險選擇；工作區圍欄、部署模式和各外掛自己的安全門仍應獨立理解。

![AI 編輯權限細分](imgs/screenshots/ai-permission-rules.png)

</details>

<details>
<summary><strong>🏗️ 系統架構與隔離邊界</strong></summary>

always-accompany 以 Deno 後端和原生 Web 前端執行，透過 Shell、Plugin、Service Generator 與 yonban 功能層組織能力。介面呼叫、模式路由、檔案 / 工具執行、持久化和非同步結果分別有明確入口。

| 邊界 | 目前作用 |
|---|---|
| 使用者 | 多使用者 / server 場景下的持久化根邊界 |
| 角色卡 | 不同角色、關係、客戶或專案使用不同記憶根、設定與對話 |
| 模式 | Chat / Code / Work 使用不同表、私有目錄、預設記錄與 P1 路線；同一角色卡的通用長期材料仍可能共用 |
| 視窗 | 約束本輪輸入、P1 候選與結果、工作區和非同步回傳 |

</details>

<details>
<summary><strong>🔭 關於 1M、2M 與更大的上下文視窗</strong></summary>

更大的視窗非常有價值，但容量、注意力、成本與任務狀態不是同一件事。always-accompany 做分層與召回，主要是為了提高注意力、最佳化上下文裡的儲存方式，尤其面向現在的大型程式碼專案和長期聊天。

或許你遇到過：聊天越久、記憶越多，AI 接收的東西越多，反應和記憶反而開始混亂、變慢；寫程式則是——哪怕給你 1M 上下文，大專案也能馬上撞到上限。

</details>

---

## 路線圖

**目前儲存庫已經具備的入口與實作**：Data + 三層記憶 · 上下文管理 · 自驅動 P1 / AI P1 · 全提示詞編輯與預設切換 · 模式記憶表 · 條件知識動態注入 · Live2D / 圖片桌寵 · 螢幕感知與遊戲陪伴 · 本機語音輸入 · PPT 生成 · MCP · 多視窗 · VS Code 擴充橋 · 9 個平台 Bot · 23 個內建外掛目錄 · 使用者外掛宿主 · 回收 / 備份鏈 · 白盒診斷 · 多語言與主題。

**近期方向**：更多 Bot 平台 · 外掛生態與範例 · TTS / 文生圖 · AI 遊戲引擎（確定性數值狀態 + LLM 敘事 + 符號渲染）

---

## 技術棧

Deno 執行環境（Node.js 相容） · Express 風格路由 · 原生 JavaScript / ESM 前端 · WebSocket · JSON / MD 本機儲存 · Electron 桌寵 · Python 可選服務（P1 資源、STT、PPT）· discord.js v14 · VS Code 擴充橋。

架構說明見[系統架構](site/wiki/developer/architecture.md)，訊息、工具與權限鏈見 [YonBan 工具體系](site/wiki/yonban/tools.md)和[審批機制](site/wiki/yonban/approval.md)。

---

## 社群

<a href="https://discord.gg/agHeDq9bqU"><img src="https://img.shields.io/badge/Discord-立即加入-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord"></a>

分享角色卡 · 發布預設與條件知識 · 貢獻外掛 · 回報 Bug · 提出真實使用案例 · 參與 benchmark · 貢獻程式碼。

---

## 使用的技術與資源

- **語音轉錄**：[MOSS-Transcribe-Diarize](https://huggingface.co/ICTNLP/MOSS-Transcribe-Diarize)（本機部署，模型約 1.8 GB，首次使用時單獨下載）
- **詞向量**：[ConceptNet Numberbatch](https://github.com/commonsense/conceptnet-numberbatch)（Speer & Lowry-Duda, 2017）
- **聯想資料**：[SWOW（Small World of Words）](https://smallworldofwords.org/) 中文聯想資料
- **分詞與詞典**：THUOCL、CoreNatureDictionary、Chinese-Synonyms 等公開資源
- **搜尋引擎橋**：[ddgs](https://pypi.org/project/ddgs/)（用於搜尋請求與結果取得）

## 致謝

- **[fount](https://github.com/steve02081504/fount)** — 專案早期的參考框架，提供了 AI 訊息處理、服務來源管理和模組載入等基礎設施思路，節省了大量底層開發時間；
- **[SillyTavern](https://github.com/SillyTavern/SillyTavern)** — AI 角色扮演與提示詞生態的重要先行者。always-accompany 支援匯入其角色卡、預設和世界書等社群格式；
- **SillyTavern 外掛社群與所有開源資源作者** — 感謝在渲染、角色、擴充、檢索和工具鏈上的探索與分享。

## 為什麼做這個專案

> 本專案的設計、架構與開發由一位想找工作的家裡蹲完成(大霧)，借助 AI 輔助程式設計，將演算法設計、仿生學思路、框架架構與邏輯思考結合在一起。

always-accompany 不是為了把熱門功能塞進同一個選單——一開始只是作者自己想用 :)。當然，它也確實有完整的外掛與框架體系，並相容多種語言。

---

<details>
<summary><strong>📸 更多功能截圖（點開看）</strong></summary>

| | | |
|---|---|---|
| ![PPT 詳細](imgs/screenshots/ppt-detail.png) **PPT 全流程** | ![安全設定](imgs/screenshots/security-settings.png) **安全與任務流程** | ![安全中心](imgs/screenshots/security-center.png) **安全防護中心** |
| ![多語言](imgs/screenshots/i18n-support.png) **多語言支援** | ![CSS 主題](imgs/screenshots/css-themes.png) **多套主題** | ![Wiki](imgs/screenshots/wiki-guide.png) **內建 Wiki** |
| ![子模式](imgs/screenshots/sub-mode-agent.png) **子模式工作流** | ![選單](imgs/screenshots/hamburger-menu.png) **上下文速覽** | ![Loop](imgs/screenshots/auto-loop.png) **自動 / 定時 Loop** |
| ![工具檢測](imgs/screenshots/tool-detection.png) **環境檢測** | ![記憶層](imgs/screenshots/memory-data-layers.png) **記憶檔案結構** | ![擴充](imgs/screenshots/browser-automation.png) **瀏覽器自動化** |
| ![外部介面](imgs/screenshots/external-interface.png) **外部介面** | | |

</details>

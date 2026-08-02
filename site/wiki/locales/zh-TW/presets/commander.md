# 司令員模式

司令員模式（Commander Mode）是預設集引擎的進階執行模式。在此模式下，預設集接管整個訊息序列的組裝——不再由各 provider 各自拼裝，而是由預設集引擎按 **五段拼裝** 規則統一產出最終發給 AI 的訊息列表。

普通模式下，預設集只提供「指令片段」，由 provider 自行決定放在哪裡。司令員模式下，預設集就是「總指揮」，精確控制每一段內容的位置。

## 五段拼裝

司令員模式將最終訊息分為五個段落，按固定順序排列：

<div class="wiki-flow">
<div class="wiki-box wiki-box-amber wiki-box-full"><b>1. beforeChat (頭部預設集)</b><small>beilu_preset_before — 系統指令、角色設定、世界書</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-blue wiki-box-full"><b>2. injectionAbove (@D>=1 注入)</b><small>beilu_injection_above — 深度 >= 1 的注入條目</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-green wiki-box-full"><b>3. chatSegment (聊天歷史)</b><small>provider 自建 — 對話核心訊息序列</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-purple wiki-box-full"><b>4. injectionBelow (@D=0 注入)</b><small>beilu_injection_below — 記憶、即時上下文等</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-red wiki-box-full"><b>5. afterChat (尾部預設集)</b><small>beilu_preset_after — jailbreak、格式要求等</small></div>
</div>

### 各段職責

| 段 | 欄位名 | 內容 | 位置語義 |
|----|--------|------|---------|
| beforeChat | beilu_preset_before | 系統指令、角色設定、世界書等 | AI 最先看到的指令 |
| injectionAbove | beilu_injection_above | 深度 >= 1 的注入條目 | 聊天歷史上方 |
| chatSegment | _(provider 自建)_ | 聊天歷史訊息序列 | 對話核心 |
| injectionBelow | beilu_injection_below | 深度 = 0 的注入條目（記憶、即時上下文等） | 聊天歷史下方，貼近最新訊息 |
| afterChat | beilu_preset_after | 尾部指令（jailbreak、格式要求等） | AI 最後看到的指令 |

## 共享層實作

五段拼裝邏輯收斂在 `_shared/commanderAssembly.mjs` 中，所有 6 家 provider（proxy / grok / claude / claude-api / ollama / gemini）共用同一份拼裝程式碼。

### 為什麼參數化而非直接回傳

六家 provider 在訊息形狀上有本質差異：

| Provider | 訊息形狀 |
|----------|---------|
| proxy | OpenAI 標準 messages（帶中繼資料標記） |
| grok / claude | 簡單 `{role, content}` |
| ollama | `{role, content}` + 圖片欄位 |
| gemini | Gemini parts 形狀（role 映射 model） |
| claude-api | Anthropic 原生格式 + 頂層 system 欄位 |

因此共享層採用參數化設計：

- `mapMsg`：各 provider 自行提供「段訊息 -> 目標形狀」的映射函式
- `chatSegment`：各 provider 預先建構好的聊天訊息段
- `extractSystem`：Anthropic 系 provider 需要將 before/after 段提取為頂層 system 欄位
- `cacheBoundary`：是否做快取邊界最佳化

### 快取邊界最佳化

當 injectionBelow 的首條訊息超過 1000 字元時（通常是記憶資料），共享層會將其從底部移到聊天段的倒數第 1 條之前。這樣做的目的是利用 API 的快取機制——記憶資料相對穩定，貼近快取邊界可以提高快取命中率。

## 門控與校驗

### 司令員模式門控

預設集條目中包含 `commander_mode` 標記時，provider 進入司令員分支。門控檢測是雙值 AND 邏輯——既要預設集標記存在，又要有實際段內容。

### Schema 校驗

共享層呼叫 `validateCommanderPreset()` 校驗預設集段欄位的存在性和類型。四個段欄位（beilu_preset_before / beilu_injection_above / beilu_injection_below / beilu_preset_after）應為陣列類型。校驗異常只告警不中斷（fail-safe），不影響訊息產出。

## TweakPrompt 中的司令員產出

預設集引擎在 TweakPrompt Round 2 階段產出司令員段內容：

<div class="wiki-flow">
<div class="wiki-box wiki-box-amber"><b>1. buildAllEntries()</b><small>引擎產出四段內容</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-blue"><b>2. 寫入 extension</b><small>beforeChat / afterChat → beilu_preset_before / beilu_preset_after</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-blue"><b>3. 寫入 extension</b><small>injectionAbove / injectionBelow → beilu_injection_above / beilu_injection_below</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-green"><b>4. Provider StructCall 拼裝</b><small>從 extension 讀取 → assembleCommanderMessages()</small></div>
</div>

## 何時使用司令員模式

| 情境 | 是否需要 |
|------|---------|
| 簡單對話 | 不需要，普通模式足夠 |
| 角色扮演、需要精確控制提示詞位置 | 建議使用 |
| 自訂複雜提示詞架構 | 必須使用 |
| 程式碼/工作模式 | 已由內建預設集自動啟用 |

## 導航

- [預設集系統概覽](overview.md) — 預設集基礎概念
- [預設集條目結構](structure.md) — 條目欄位詳解
- [訊息管線](../developer/message-pipeline.md) — 完整訊息流轉鏈路

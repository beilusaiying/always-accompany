# 預設集條目結構

預設集引擎（PresetEngine）相容 SillyTavern 預設集格式。一個預設集 JSON 檔案由兩部分組成：**條目列表**（prompts）和**排序表**（prompt_order）。引擎負責解析這些資料，按規則排序後產出四段訊息（beforeChat / afterChat / injectionAbove / injectionBelow），交給下游 provider 組裝。

## 預設集 JSON 結構

<div class="wiki-grid wiki-grid-3">
<div class="wiki-group" style="grid-column: span 3">
<div class="wiki-group-title">prompts[] — 條目陣列</div>
<div class="wiki-grid wiki-grid-4">
<div class="wiki-card"><div class="wiki-card-title">identifier</div><div class="wiki-card-desc">唯一識別碼</div></div>
<div class="wiki-card"><div class="wiki-card-title">name</div><div class="wiki-card-desc">顯示名稱</div></div>
<div class="wiki-card"><div class="wiki-card-title">role</div><div class="wiki-card-desc">訊息角色 (system / user / assistant)</div></div>
<div class="wiki-card"><div class="wiki-card-title">content</div><div class="wiki-card-desc">條目文字內容（支援巨集）</div></div>
<div class="wiki-card"><div class="wiki-card-title">injection_position</div><div class="wiki-card-desc">注入位置 (0=afterChat / 1=beforeChat)</div></div>
<div class="wiki-card"><div class="wiki-card-title">injection_depth</div><div class="wiki-card-desc">注入深度（插入聊天歷史的位置）</div></div>
<div class="wiki-card"><div class="wiki-card-title">enabled</div><div class="wiki-card-desc">是否啟用</div></div>
<div class="wiki-card"><div class="wiki-card-title">marker</div><div class="wiki-card-desc">是否為內建標記（如 chatHistory）</div></div>
</div>
</div>
</div>

<div class="wiki-grid wiki-grid-2">
<div class="wiki-group">
<div class="wiki-group-title">prompt_order[] — 排列順序</div>
<div class="wiki-card"><div class="wiki-card-title">character_id</div><div class="wiki-card-desc">100000=系統級 / 100001=使用者級</div></div>
<div class="wiki-card"><div class="wiki-card-title">order[]</div><div class="wiki-card-desc">該級別下的 identifier 排列</div></div>
</div>
<div class="wiki-group">
<div class="wiki-group-title">model_params — 模型參數（可選）</div>
<div class="wiki-card"><div class="wiki-card-desc">預設集攜帶的溫度、採樣等模型參數</div></div>
</div>
</div>

## 條目分類

### 內建標記條目（Marker）

引擎預定義了 12 個內建標記，它們是預設集結構的骨架：

| Marker | 作用 | 巨集展開對象 |
|--------|------|-----------|
| main | 主系統提示 | - |
| nsfw | NSFW 相關指令 | - |
| jailbreak | 越獄/解鎖指令 | - |
| chatHistory | 聊天歷史分割點 | _chat_log |
| charDescription | 角色描述 | char_prompt |
| charPersonality | 角色性格 | char_personality |
| scenario | 情境設定 | scenario |
| personaDescription | 使用者人設描述 | user_prompt |
| worldInfoBefore | 世界書（前置） | world_prompt |
| worldInfoAfter | 世界書（後置） | world_prompt_after |
| dialogueExamples | 對話範例 | dialogue_examples |
| enhanceDefinitions | 增強定義 | - |

Marker 條目在司令員模式下會展開為對應模組的實際內容（透過巨集環境 env 注入）。

### 使用者自訂條目

使用者可自由新增條目，identifier 不與內建標記重複即可。透過 injection_position 和 injection_depth 控制條目在最終訊息中的位置。

## 排序規則

### 兩級排序

預設集透過 prompt_order 定義排序：

- **系統級**（character_id = 100000）：包含內建 Marker 和系統指令，構成提示詞骨架
- **使用者級**（character_id = 100001）：使用者新增的自訂條目

### 注入位置

| injection_position | 含義 | 放置位置 |
|-------------------|------|---------|
| 0 | afterChat | 聊天歷史之後（尾部預設集） |
| 1 | beforeChat | 聊天歷史之前（頭部預設集） |

### 注入深度（injection_depth）

注入深度決定條目在聊天歷史中的插入位置：

- **深度 0**：最底部，緊貼最新訊息
- **深度 4**（ST 預設）：從底部往上數第 4 條訊息處
- **深度 N**：從底部往上數第 N 條訊息處

深度越小，條目離最新對話越近，AI 越容易「看到」並遵循。

## 引擎工作流

PresetEngine 的核心方法 `buildAllEntries()` 按以下步驟工作：

<div class="wiki-flow">
<div class="wiki-box wiki-box-amber"><b>1. 遍歷 prompt_order</b><small>按系統級 → 使用者級的順序處理</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-blue"><b>2. 過濾未啟用條目</b><small>跳過 enabled = false</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-green"><b>3. Marker 展開</b><small>內建標記條目展開為巨集環境中的實際內容</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-green"><b>4. 巨集替換</b><small>自訂條目執行 evaluateMacros</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-purple"><b>5. 按 injection_position 分組</b><small>→ beforeChat / afterChat</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-purple"><b>6. 按 injection_depth 分流</b><small>深度 >= 1 → injectionAbove / 深度 = 0 → injectionBelow</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-red"><b>7. 回傳四段產物</b><small>供 TweakPrompt 消費</small></div>
</div>

## 巨集替換

條目內容支援巨集語法。在 buildAllEntries 階段，引擎會呼叫 `evaluateMacros` 對條目文字進行替換。常用巨集包括：

- `{{char}}` — 目前角色名
- `{{user}}` — 目前使用者名稱
- `{{time}}` — 目前時間
- 自訂變數巨集

詳見 [巨集系統](../macros/overview.md)。

## 模型參數提取

預設集可攜帶模型參數。引擎透過 `extractModelParams` 從預設集資料中提取以下 canonical 參數：

| 參數 | 說明 | 預設值 |
|------|------|-------|
| temperature | 產生溫度 | 由 PARAM_SCHEMA 定義 |
| top_p | 核採樣 | 由 PARAM_SCHEMA 定義 |
| top_k | Top-K 採樣 | 由 PARAM_SCHEMA 定義 |
| max_tokens | 最大輸出 token 數 | 由 PARAM_SCHEMA 定義 |
| frequency_penalty | 頻率懲罰 | 由 PARAM_SCHEMA 定義 |
| presence_penalty | 存在懲罰 | 由 PARAM_SCHEMA 定義 |
| repetition_penalty | 重複懲罰 | 由 PARAM_SCHEMA 定義 |
| min_p | Min-P 採樣 | 由 PARAM_SCHEMA 定義 |
| top_a | Top-A 採樣 | 由 PARAM_SCHEMA 定義 |
| seed | 隨機種子 | 由 PARAM_SCHEMA 定義 |

所有預設值統一由 `paramSchema.mjs` 的 PARAM_SCHEMA 定義，確保引擎層、應用層、前端 UI 三處同源。

## 導航

- [預設集系統概覽](overview.md) — 預設集基礎概念
- [司令員模式](commander.md) — 預設集接管訊息組裝

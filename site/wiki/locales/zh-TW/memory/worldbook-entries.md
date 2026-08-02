# 條目與觸發機制

世界書條目的完整欄位和三種觸發模式。條目在[世界書編輯](beilu:editor/worldbook)中建立和管理。

## 條目結構

每個世界書條目由以下欄位組成：

### 核心欄位

| 欄位 | 類型 | 說明 |
|------|------|------|
| **key** | 字串/陣列 | 主關鍵詞，用於觸發比對 |
| **keysecondary** | 字串/陣列 | 輔助關鍵詞，與主關鍵詞配合使用 |
| **content** | 字串 | 注入給 AI 的資訊內容 |

### 觸發控制欄位

| 欄位 | 類型 | 說明 |
|------|------|------|
| **constant** | 布林 | 是否為常駐條目（每輪注入） |
| **useRegex** | 布林 | 關鍵詞是否使用正規表示式比對 |
| **selective** | 布林 | 是否啟用輔助關鍵詞的聯合判定 |

### 注入控制欄位

| 欄位 | 類型 | 說明 |
|------|------|------|
| **position** | 列舉 | 注入位置：before（角色描述前）/ after（角色描述後）/ atDepth（聊天記錄指定深度）/ AN / EM |
| **depth** | 數字 | 當 position 為 atDepth 時，指定插入深度（第 N 輪對話前） |

### 機率與節奏欄位

| 欄位 | 類型 | 說明 |
|------|------|------|
| **probability** | 數字(0-100) | 觸發機率，100 表示必定觸發 |
| **sticky** | 數字 | 觸發後持續注入的輪次數 |
| **cooldown** | 數字 | 觸發後冷卻的輪次數（冷卻期間不再觸發） |
| **delay** | 數字 | 比對後延遲幾輪才實際注入 |

### 開關欄位

| 欄位 | 類型 | 說明 |
|------|------|------|
| **enabled** | 布林 | 全域啟用開關，各角色互通 |
| **boundCharName** | 字串 | 角色綁定，只在指定角色時生效 |

## 三種觸發模式詳解

### 1. constant（常駐模式）

```
constant: true
```

條目始終注入，不檢查關鍵詞。適用於：
- 基本世界觀設定
- 通用行為規則
- 始終需要 AI 知道的資訊

### 2. regex（關鍵詞/正規表示式比對模式）

```
constant: false
useRegex: true/false
selective: true/false
```

根據對話內容比對關鍵詞來決定是否觸發。

**比對邏輯**：

- `useRegex: false`：關鍵詞作為純文字比對（包含即觸發）
- `useRegex: true`：關鍵詞作為正規表示式比對

**selective 的作用**：

- `selective: false`：只看主關鍵詞（key），任一比對即觸發
- `selective: true`：主關鍵詞（key）和輔助關鍵詞（keysecondary）都必須比對才觸發

selective 模式用於精確控制觸發條件。例如：key 設為「魔法」，keysecondary 設為「禁忌」，則只有當對話中同時出現「魔法」和「禁忌」時才注入關於禁忌魔法的設定。

### 3. dynamic（動態檢查模式）

動態模式不檢查對話文字，而是檢查記憶表格中的特定值。例如：

- 檢查 #0 時空表中「地點」欄位是否為「森林」
- 檢查 #2 社交表中「好感度」是否超過某個閾值

這允許世界書條目根據角色目前狀態動態生效。

## 注入位置詳解

### before / after

注入到角色描述（character description）的前方或後方。這些位置距離系統提示詞較近，AI 會給予較高的注意力。

### atDepth

注入到聊天記錄的指定深度。depth 的含義：

- `depth: 0`：最近一條訊息之後
- `depth: 1`：最近一條訊息之前
- `depth: N`：第 N 輪對話之前

depth 越小，離最新訊息越近，AI 越重視。

### AN / EM

AN（Author's Note）和 EM 是原生的注入位置，由上游框架定義。

## 機率與節奏控制

機率和節奏欄位配合使用，可以創造自然的資訊出現模式：

**範例：隨機事件**
- `probability: 30`、`sticky: 3`、`cooldown: 10`
- 每輪有 30% 機率觸發；觸發後持續注入 3 輪；然後冷卻 10 輪

**範例：延遲伏筆**
- `delay: 5`
- 關鍵詞比對後，延遲 5 輪再注入，製造「事後才揭示」的效果

## 雙開關的互動

```
enabled: true  + boundCharName: ""      → 所有角色都生效
enabled: true  + boundCharName: "Alice"  → 僅角色 Alice 時生效
enabled: false + (任意)                  → 完全不生效
```

enabled 是全域開關，跨角色共享狀態。boundCharName 是角色級過濾。兩者是 AND 關係。

## 運行鏈

```
系統建構上下文
    ↓
遍歷所有世界書條目
    ↓
對每個條目：
  1. 檢查 enabled → false 則跳過
  2. 檢查 boundCharName → 不比對則跳過
  3. 檢查 cooldown → 冷卻中則跳過
  4. 判斷觸發模式：
     - constant → 直接通過
     - regex → 比對對話內容
     - dynamic → 檢查記憶表格值
  5. 檢查 probability → 隨機判定
  6. 檢查 delay → 未到則暫不注入
    ↓
通過的條目按 position 和 depth 放入上下文的對應位置
    ↓
更新 sticky / cooldown 計數器
```

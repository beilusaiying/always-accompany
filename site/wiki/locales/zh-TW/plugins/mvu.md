# 變數系統 (beilu-mvu)

beilu-mvu（Model-View-Update）是 always-accompany 的變數系統外掛。它讓預設集、角色卡和 AI 回覆能夠讀寫變數，實現跨輪次的狀態追蹤。例如角色的好感度、HP、任務進度等動態數值，都可以透過變數系統管理。

## 變數類型

| 類型 | 作用域 | 生命週期 | 巨集語法 |
|------|--------|---------|--------|
| 區域變數 | 目前對話 | 對話存續期間 | `{{getvar::名稱}}` / `{{setvar::名稱::值}}` |
| 全域變數 | 跨對話 | 持久化 | `{{getglobalvar::名稱}}` / `{{setglobalvar::名稱::值}}` |

## 變數巨集

### 讀取變數

```
{{getvar::hp}}           → 讀取區域變數 hp 的值
{{getglobalvar::score}}  → 讀取全域變數 score 的值
```

### 寫入變數

```
{{setvar::hp::100}}           → 設定區域變數 hp = 100
{{setglobalvar::score::50}}   → 設定全域變數 score = 50
```

### 數值運算

```
{{addvar::hp::-10}}           → hp 減少 10
{{addglobalvar::score::5}}    → score 增加 5
```

## 管線介面

### GetPrompt

beilu-mvu 的 GetPrompt 介面可以將目前變數狀態注入到提示詞中，讓 AI 了解目前的變數值。

### TweakPrompt

在 TweakPrompt 階段，beilu-mvu 處理訊息中的變數巨集替換。

### ReplyHandler

AI 回覆到達後，beilu-mvu 解析回覆中的變數操作命令（如果 AI 使用了特定的變數操作標籤），執行對應的讀寫操作。

## 與巨集系統的關係

beilu-mvu 的變數巨集是巨集系統的一個子集。變數巨集在後端替換階段（發送給 AI 之前）執行。巨集替換引擎 `evaluateMacros` 在遇到變數巨集時會調用 beilu-mvu 的讀寫函式。

詳見 [變數巨集](../macros/variables.md)。

## 使用情境

| 情境 | 變數範例 |
|------|---------|
| RPG 遊戲 | HP、MP、金幣、等級 |
| 好感度系統 | 好感度數值、關係階段 |
| 任務追蹤 | 任務狀態（進行中/完成）、進度百分比 |
| 計數器 | 對話輪次、事件觸發次數 |
| 條件分支 | 根據變數值決定 AI 回覆風格 |

## 資料儲存

- 區域變數隨對話儲存
- 全域變數透過 SetData 持久化

## 導覽

- [外掛概覽](overview.md) — 外掛系統簡介
- [變數巨集](../macros/variables.md) — 變數巨集語法詳解
- [腳本引擎](scripts.md) — 更複雜的邏輯控制

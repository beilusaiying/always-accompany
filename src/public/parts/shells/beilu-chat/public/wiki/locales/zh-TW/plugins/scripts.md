# 腳本引擎

always-accompany 提供 EJS 範本渲染能力（beilu-ejs 外掛），允許在預設集條目和角色卡中使用 EJS 範本語法編寫動態內容。這比簡單的巨集替換更強大，可以實現條件判斷、迴圈、複雜計算等邏輯。

## EJS 範本引擎 (beilu-ejs)

### 基本語法

EJS（Embedded JavaScript）允許在文字中嵌入 JavaScript 程式碼：

| 標籤 | 說明 | 範例 |
|------|------|------|
| `<% %>` | 執行 JS 程式碼（不輸出） | `<% if (x > 5) { %>` |
| `<%= %>` | 輸出運算式結果（HTML 跳脫） | `<%= user %>` |
| `<%- %>` | 輸出運算式結果（不跳脫） | `<%- rawHtml %>` |

### 可用的範本變數

EJS 範本在執行時可以存取巨集環境中的變數，包括：

- `char` — 角色名
- `user` — 使用者名稱
- 自訂變數（透過 beilu-mvu 設定的變數）
- 其他巨集環境中的值

### 沙箱安全

beilu-ejs 預設在沙箱中執行 EJS 範本，限制可存取的全域物件和 API，防止惡意程式碼執行。

**sandboxOptOut** 是一個安全敏感開關：關閉沙箱後 EJS 可以存取完整的 Node.js 環境（包括檔案系統、網路等），這在多使用者環境下有嚴重安全風險。因此 sandboxOptOut 的修改需要實例 owner 權限。

### 使用情境

| 情境 | 說明 |
|------|------|
| 條件指令 | 根據模式/變數值切換不同的系統提示 |
| 動態清單 | 根據角色關係資料產生人物清單 |
| 複雜格式化 | 將結構化資料渲染為 AI 友好的文字 |
| 計算與統計 | 在預設集中進行數值計算 |

## 使用者外掛腳本 (beilu-plugin-host)

### 概述

beilu-plugin-host 允許使用者編寫和載入自訂 JavaScript 外掛腳本。使用者外掛與內建外掛享有相同的介面能力（GetPrompt / TweakPrompt / ReplyHandler 等）。

### 安全限制

使用者外掛腳本的執行同樣受安全策略管控。在伺服器部署模式下，使用者外掛的子程序 spawn 需要 owner 顯式授權。

## change-prompt 產生器

change-prompt 是一個特殊的服務產生器，允許在預設集條目中使用 `${}` 語法進行範本求值。它也受 deployGatedAllow 門控保護。

## 腳本的執行時機

| 引擎 | 執行階段 | 說明 |
|------|---------|------|
| EJS (beilu-ejs) | 巨集替換階段 | 在 evaluateMacros 過程中執行 |
| 正規表示式 (beilu-regex) | TweakPrompt / ReplyHandler | 在訊息發送前/回覆後執行 |
| 使用者外掛 (plugin-host) | GetPrompt / TweakPrompt / ReplyHandler | 與內建外掛同時機 |

## 導覽

- [外掛概覽](overview.md) — 外掛系統簡介
- [正規表示式增強 (beilu-regex)](regex.md) — 正規表示式腳本引擎
- [變數系統 (beilu-mvu)](mvu.md) — 變數讀寫
- [外掛開發](../developer/plugin-dev.md) — 編寫自訂外掛

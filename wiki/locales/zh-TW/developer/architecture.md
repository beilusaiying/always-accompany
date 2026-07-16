# 系統架構

always-accompany 用 Deno 後端 + 原生前端，透過 parts 體系組織功能模組。

## 技術堆疊

| 層 | 技術 |
|---|------|
| 執行階段 | Deno（Node.js 相容） |
| 後端框架 | Express |
| 前端 | 原生 HTML/CSS/JS（無框架） |
| 即時通訊 | WebSocket |
| 資料儲存 | JSON 檔案系統（無資料庫） |

## 目錄結構

```
beilu-always-accompany/
├── src/
│   ├── server/              ← 伺服器核心（啟動/路由/中介軟體）
│   ├── scripts/             ← 共用腳本工具
│   ├── public/
│   │   └── parts/
│   │       ├── shells/      ← 殼（UI + 端點）
│   │       │   └── beilu-chat/  ← 主殼
│   │       ├── plugins/     ← 外掛
│   │       └── serviceGenerators/ ← AI 服務產生器
│   └── yonban/              ← 核心功能庫（遷移後的實作體）
│       └── core/
│           ├── functions/   ← 通用無狀態功能
│           │   ├── api/     ← AI API 呼叫（6 家 provider）
│           │   ├── prompt/  ← 預設集引擎 + 巨集 + 變數
│           │   ├── memory/  ← 記憶系統
│           │   ├── security/ ← 安全體系
│           │   ├── screenshot/ ← 截圖感知
│           │   ├── web/     ← 聯網搜尋
│           │   ├── regex/   ← 正規表示式引擎
│           │   └── ...
│           ├── pipelines/   ← 管線執行階段
│           └── transport/   ← IDE 橋接
├── data/                    ← 使用者資料（執行階段產生）
│   ├── config.json          ← 全域設定
│   └── users/               ← 使用者資料（per-user 隔離）
│       └── <username>/
│           ├── shells/chat/ ← 對話資料
│           ├── presets/     ← 預設集檔案
│           └── ...
└── desktop-eye/             ← 桌寵 Electron + Python 截圖
```

## Parts 體系

### 三類 Part

| 類型 | 目錄 | 說明 |
|------|------|------|
| Shell（殼） | parts/shells/ | 提供 UI + HTTP 端點，系統的「外殼」 |
| Plugin（外掛） | parts/plugins/ | 功能擴充，透過標準介面參與訊息管線 |
| Service Generator（服務產生器） | parts/serviceGenerators/ | AI API 呼叫實作 |

<div class="wiki-grid wiki-grid-3">
  <div class="wiki-card">
    <div class="wiki-card-title" style="color: var(--beilu-amber-fg);">Shell（殼）</div>
    <div class="wiki-card-desc">提供 UI 介面和 HTTP 端點。系統的「外殼」，使用者直接互動的入口。</div>
    <div style="margin-top:6px;"><span class="wiki-badge">parts/shells/</span></div>
  </div>
  <div class="wiki-card">
    <div class="wiki-card-title" style="color: oklch(0.65 0.15 300);">Plugin（外掛）</div>
    <div class="wiki-card-desc">功能擴充模組，透過 GetPrompt / TweakPrompt / ReplyHandler 等標準介面參與訊息管線。</div>
    <div style="margin-top:6px;"><span class="wiki-badge">parts/plugins/</span></div>
  </div>
  <div class="wiki-card">
    <div class="wiki-card-title" style="color: oklch(0.65 0.15 150);">Service Generator（服務產生器）</div>
    <div class="wiki-card-desc">AI API 呼叫的具體實作，封裝各家 provider 的請求/回應差異。</div>
    <div style="margin-top:6px;"><span class="wiki-badge">parts/serviceGenerators/</span></div>
  </div>
</div>

### 載入機制

`parts_loader.mjs` 負責發現和載入所有 Part：

- 按目錄約定掃描 `beilu-part.json` / `info.json`
- 載入各 Part 的 `main.mjs`（入口檔案）
- 提取 interfaces 物件，註冊各類介面（GetPrompt / TweakPrompt / ReplyHandler 等）

### 薄殼 re-export 範式

yonban 遷移後，許多外掛的 `main.mjs` 變成了薄殼——只做 re-export，實際程式碼在 `yonban/core/functions/` 中。薄殼永不刪除（P 型薄殼），因為 parts_loader 按約定位置發現和載入。

## yonban 層

yonban 是 always-accompany 的核心功能庫層。與 parts 的區別：

- **parts**：遵循 always-accompany 外掛協定，有 info.json 和 interfaces
- **yonban**：純功能模組，被 parts 和伺服器核心引用

### 遷移背景

原先所有程式碼在 parts 目錄中。yonban 遷移將「通用無狀態後端功能」集中到 `core/functions/<組>/`，使程式碼組織更清晰、可複用性更高。

## 資料層

always-accompany 使用 JSON 檔案而非資料庫。資料操作透過原子寫（tmp + rename）保證一致性。

### per-user 資料隔離

在 `data/users/<username>/` 下，每個使用者有獨立的資料目錄。關鍵資料路徑透過 `getUserDataDir(username)` 權威函式取得。

### 資料檔案

| 檔案 | 說明 |
|------|------|
| config.json | 全域設定（Owner/密鑰/使用者清單） |
| users/\<user\>/shells/chat/\<chatid\>.json | 對話資料 |
| users/\<user\>/presets/config.json | 預設集設定 |
| users/\<user\>/presets/registry.json | 預設集註冊表 |
| users/\<user\>/presets/\*.json | 預設集檔案 |

## 模組間相依原則

- **安全模組**（path_confine / auth / security_policy）處於相依最底層，不引用上層模組
- **parts_loader** 在 server 域，被 endpoints / requestBuilder 引用
- **外掛之間** 透過 extension 欄位傳遞資料（間接通訊），不直接 import
- **循環相依** 透過惰性動態 import 打破

<div class="wiki-layers">
  <div class="wiki-layer wiki-layer-amber">
    <span class="wiki-layer-label">Shell 層</span>
    UI + 端點 — 使用者請求入口，呼叫下層服務
  </div>
  <div class="wiki-layer wiki-layer-purple">
    <span class="wiki-layer-label">Plugin 層</span>
    功能擴充 — 透過 extension 間接通訊，不互相 import
  </div>
  <div class="wiki-layer wiki-layer-blue">
    <span class="wiki-layer-label">Server 層</span>
    parts_loader / endpoints / requestBuilder — 載入與排程
  </div>
  <div class="wiki-layer wiki-layer-green">
    <span class="wiki-layer-label">yonban 層</span>
    核心功能庫 — 純函式模組，被上層引用
  </div>
  <div class="wiki-layer">
    <span class="wiki-layer-label">安全層</span>
    path_confine / auth / security_policy — 最底層，不引用上層
  </div>
</div>

## 導覽

- [訊息管線](message-pipeline.md) — 訊息流轉全鏈路
- [外掛開發](plugin-dev.md) — 編寫自訂外掛
- [API 端點參考](api-reference.md) — HTTP/WS 介面
- [安全中心](../security/overview.md)（[開啟面板](beilu:settings/security)） — 安全架構

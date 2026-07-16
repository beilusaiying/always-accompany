# 安全中心

[設定 → 安全中心](beilu:settings/security)查看安全狀態，管理安全策略。

## 快速操作

1. 開啟[安全中心](beilu:settings/security)面板
2. 查看面板頂部的 **安全總結**，瞭解目前安全狀態
3. 點擊 **一鍵安全檢查**，掃描所有檢查項並彙總結果
4. 在檢查項列表中逐項查看和調整安全策略

### 面板控制項一覽

| 控制項 | 說明 |
|------|------|
| 安全總結 | 面板頂部展示目前安全狀態概覽 |
| 一鍵安全檢查 | 按鈕，掃描所有檢查項並彙總結果 |
| 檢查項列表 | 根據檢查項類型動態算繪不同控制項（下拉選擇 / 開關 / EJS 設定 / 列表），用於逐項查看和調整安全策略 |
| 內容過濾 — 黑名單關鍵詞 | 文字輸入，設定需要過濾的關鍵詞 |
| 內容過濾 — 使用者名稱過濾 | 文字輸入，設定需要過濾的使用者名稱 |
| iframe 安全等級 | 3 檔選擇，控制 iframe 嵌入的限制級別 |

檢查項列表中的每一項對應一個具體的安全策略（如部署模式、命令執行、沙箱設定等），owner 可在此集中管理，無需逐個進入外掛設定。

## 切換部署模式

always-accompany 區分兩種部署模式，安全策略隨之調整：

### local 模式（預設）

適用於個人本機使用。安全策略相對寬鬆：

- 檔案操作預設在工作區內放行
- 命令執行預設允許
- 軟連結不做實路徑校驗
- 唯一使用者即 owner

### server 模式

適用於多使用者共享部署。安全策略收緊：

- 命令執行預設關閉，需 owner 顯式開啟
- 軟連結做實路徑校驗（防軟連結逃逸）
- 安全敏感設定寫入需 owner 權限
- 無效的部署模式值回退到 server（fail-safe）

透過環境變數 `BEILU_DEPLOY_MODE=server` 或安全中心面板設定 `config.deployMode` 切換。

## 管理外掛安全設定

以下外掛設定的修改需要 owner 權限（在[外掛管理](beilu:settings/plugins)面板設定）：

| 外掛 | 敏感設定 | 風險 |
|------|---------|------|
| beilu-files | allowExec / rootPath / workspaceRoot | 開啟命令執行 / 改沙箱邊界 |
| beilu-ejs | sandboxOptOut | 關閉 EJS 沙箱 |
| beilu-regex | regexGuard | 關閉 ReDoS 防護 |

這些設定的寫入在 parts_router 的 config/setdata 入口被統一攔截（`partConfigWriteNeedsOwner`），而非在各外掛內部各自攔截。

## 三個核心原則

1. **安全預設**：所有安全開關預設處於最安全狀態，需要主動開啟高風險功能
2. **Owner 可控**：安全策略由執行個體 owner 掌控，普通使用者無法修改安全敏感設定
3. **縱深防禦**：每個安全域（路徑/網路/執行/認證）都有多層防護，單層被繞過不會導致全面失守

## 安全架構總覽

| 安全域 | 核心機制 | 保護目標 |
|--------|---------|---------|
| 認證鑑權 | JWT + API Key + 暴力破解防禦 | 使用者身分 |
| 路徑圍欄 | confinePath + confineSegment | 檔案系統 |
| 對話歸屬 | router.param("chatid") 中央校驗 | 對話資料 |
| 內容安全 | CSP + WS Origin 校驗 | 前端安全 |
| 執行門控 | deployGatedAllow | 命令執行 |
| 外掛安全 | partConfigWriteNeedsOwner | 外掛設定 |
| 令牌閘 | pet-token 鑑權 | 截圖注入 |

## 檔案操作安全

beilu-files 的四層縱深防禦：

1. **路徑規範化**：消化 `..`、絕對路徑注入，將路徑錨定到工作區
2. **系統路徑阻斷**：阻止存取系統敏感目錄和檔案
3. **工作區沙箱**：所有操作必須在 workspaceRoot 內
4. **白名單/黑名單**：精細化路徑控制

詳見 [檔案操作 (beilu-files)](../plugins/files.md)。可在[外掛管理](beilu:settings/plugins)面板設定。

## 對話資料保護

### 歸屬校驗

所有以 `:chatid` 為路徑參數的端點，都透過 `router.param("chatid")` 中央歸屬校驗——驗證請求使用者是否是該對話的 owner。未通過校驗的請求回傳 403。

### Body 中的 chatid

部分端點透過請求主體傳遞 chatid（如 manual-tool-call、group bind、branch），這些端點有獨立的 inline 校驗邏輯。

## 網路安全

- **CSP（內容安全策略）**：已實裝，限制可載入資源的來源
- **WS Origin 校驗**：WebSocket 連接時校驗 Origin 標頭，防止跨站 WebSocket 劫持
- **safeFetch**：連網請求透過安全抓取函式，內建逾時和惡意 URL 過濾

## 多使用者隔離

在 server 模式下，always-accompany 對以下資料進行使用者級隔離：

- 對話資料和聊天歷史
- 預設集設定和預設集檔案
- 外掛設定（透過 AsyncLocalStorage 實作 per-user 隔離）
- 檔案操作的工作區設定
- 記憶系統資料

## 導覽

- [權限與鑑權](auth.md) — JWT / API Key / 權限分級詳解
- [檔案操作 (beilu-files)](../plugins/files.md) — 檔案安全機制
- [外掛概覽](../plugins/overview.md) — 外掛安全設定
